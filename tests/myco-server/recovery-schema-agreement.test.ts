/**
 * The oracle that holds an export to the schema captured before it ran: the captured `CREATE TABLE` definitions
 * against the definitions the exported bytes actually carry, read through the one statement splitter an import reads
 * an export with. A definition inside a row value is a row value; a definition that changed is a disagreement.
 */
import { expect, it } from 'bun:test';
import {
  capturedDefinitions, continueAttempt, definitionsDisagree, freshScan, PRODUCER_LIMITS, publishAttempt,
  type AttemptCheckpoint, type AttemptPart, type AttemptState, type ProducerPorts, type RangeAnswer, type ScanProgress,
} from '@myco-server-worker/core/recovery-producer.js';
import { newInventoryProgress } from '@myco-server-worker/core/recovery-inventory.js';
import { normalizeDefinition, tableDefinition } from '@myco-server-worker/core/sql-statements.js';

const SESSIONS = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, title TEXT)';

function checkpoint(initial: Partial<AttemptState>): AttemptCheckpoint & { state: AttemptState; signed: string | null } {
  const state: AttemptState = {
    id: 1, stage: 'download', prefix: 'staging/1', startedAt: 0, error: null, attempts: 0, bookmark: 'b1', polls: 1,
    exportStartedAt: 0, exportCompletedAt: 0, reExports: 0, sqlBytes: null, sqlEtag: null, uploadId: 'upload-1',
    downloadOffset: 0, reconcileOffset: 0, reconciled: 0, tables: ['sessions'], captured: {},
    inventoryStartedAt: null, inventoryParts: 0, inventoryBytes: 0, inventoryScan: newInventoryProgress().scan,
    inventoryScanBytes: '', inventoryDigest: null, databaseSha256: null, databaseBytes: null, copyStartedAt: null,
    completedAt: null, admission: { source: { target: 'cloudflare', locator: 'account-1/database-1' }, startedAt: '1970-01-01T00:00:00.000Z', schema: { sha256: 'c'.repeat(64), bytes: 1 }, configuration: {}, credentialsRequired: [] }, ...freshScan(), ...initial,
  };
  const store = {
    state,
    held: [] as AttemptPart[],
    signed: 'https://signed/one' as string | null,
    open: () => (store.state.stage === 'export' || store.state.stage === 'download' ? store.state : null),
    update: (_id: number, fields: Partial<AttemptState>) => { Object.assign(store.state, fields); },
    parts: () => [...store.held].sort((left, right) => left.part - right.part),
    recordPart: (_id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress) => {
      store.held = [...store.held.filter((held) => held.part !== part.part), part];
      Object.assign(store.state, progress, { downloadOffset });
    },
    clearParts: () => { store.held = []; },
    // These stages end at the inventory hand-off, so the objects an inventory would register are never asked for.
    recordInventory: () => { throw new Error('the schema stages read no inventory'); },
    pendingObjects: () => [],
    recordCopied: () => { throw new Error('the schema stages copy no object'); },
    objects: () => [],
    objectCounts: () => ({ registered: 0, staged: 0 }),
    signedUrl: async () => store.signed,
    setSignedUrl: async (_id: number, url: string | null) => { store.signed = url; },
  };
  return store;
}

/** Stages one export, handed to the producer in the chunks a ranged download would deliver it in. */
async function stage(sql: string, captured: Record<string, string>, chunkBytes = 4_096) {
  const bytes = new TextEncoder().encode(sql);
  const chunks: Uint8Array[] = [];
  for (let at = 0; at < bytes.byteLength; at += chunkBytes) chunks.push(bytes.subarray(at, Math.min(at + chunkBytes, bytes.byteLength)));
  const state = checkpoint({ captured, sqlBytes: bytes.byteLength });
  const answers: RangeAnswer[] = chunks.map((chunk) => ({ status: 'part', bytes: chunk, length: chunk.byteLength, total: bytes.byteLength, etag: 'w/"one"' }));
  const port: ProducerPorts = {
    now: () => 0,
    async pollExport() { throw new Error('the staged export needs no poll'); },
    async readRange() {
      const next = answers.shift();
      if (next === undefined) throw new Error('the test supplied no further range answer');
      return next;
    },
    async beginUpload() { return 'upload-1'; },
    async writePart(_prefix, _uploadId, part) { return { sha256: `sha-${part}`, etag: `etag-${part}` }; },
    async completeUpload() { return { bytes: bytes.byteLength }; },
    async abortUpload() {},
    async readStoredRange() { return null; },
    async storedSize() { return bytes.byteLength; },
    async writeStagingFile() {},
    async readStagedPart() { throw new Error('this stage reads no staged part'); },
    async digest() { throw new Error('this stage takes no digest'); },
    async copyObject() { throw new Error('this stage copies no object'); },
    async readStagingFile() { return null; },
  };
  const report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, partBytes: chunkBytes });
  return { report, state };
}

const captured = (...definitions: string[]): Record<string, string> =>
  Object.fromEntries(definitions.map((sql) => {
    const table = tableDefinition(sql);
    if (table === null) throw new Error(`the test named no table in ${sql}`);
    return [table.name, table.definition];
  }));

it('reads a definition the export carries, and agrees with a capture of the same definitions', async () => {
  const { report, state } = await stage(`${SESSIONS};\nINSERT INTO sessions VALUES('s1','one');\n`, captured(SESSIONS));
  expect([report.stage, report.error]).toEqual(['inventory', undefined]);
  expect(Object.keys(state.state.defined)).toEqual(['sessions']);
});

it('takes a definition inside a row value for the value it is', async () => {
  // A prompt a member stored names a table of its own; the export carries it as text, not as a definition.
  const prompt = "INSERT INTO sessions VALUES('s1','CREATE TABLE phantom (id TEXT)');";
  const { report, state } = await stage(`${SESSIONS};\n${prompt}\n`, captured(SESSIONS));
  expect([report.stage, Object.keys(state.state.defined)]).toEqual(['inventory', ['sessions']]);
});

it('reads a definition split across parts once it is whole, naming no partial identifier', async () => {
  const sql = `${SESSIONS};\n`;
  for (const chunkBytes of [7, 13, 21, 32]) {
    const { report, state } = await stage(sql, captured(SESSIONS), chunkBytes);
    expect({ chunkBytes, stage: report.stage, tables: Object.keys(state.state.defined) })
      .toEqual({ chunkBytes, stage: 'inventory', tables: ['sessions'] });
  }
});

it('refuses an export that defines a captured table differently', async () => {
  const changed = 'CREATE TABLE sessions (id TEXT PRIMARY KEY, title INTEGER)';
  const { report } = await stage(`${changed};\n`, captured(SESSIONS));
  expect([report.stage, report.error]).toEqual(['failed', 'schema_disagrees']);
});

it('refuses an export that leaves a captured table undefined, and one that defines a table the capture never held', async () => {
  const missing = await stage(`${SESSIONS};\n`, captured(SESSIONS, 'CREATE TABLE events (id TEXT)'));
  expect([missing.report.stage, missing.report.error]).toEqual(['failed', 'schema_disagrees']);
  const extra = await stage(`${SESSIONS};\nCREATE TABLE events (id TEXT);\n`, captured(SESSIONS));
  expect([extra.report.stage, extra.report.error]).toEqual(['failed', 'schema_disagrees']);
});

it('accepts the sequence table an export creates for itself, which no capture describes', async () => {
  const sql = `${SESSIONS};\nCREATE TABLE sqlite_sequence(name,seq);\nDELETE FROM sqlite_sequence;\n`;
  const { report } = await stage(sql, captured(SESSIONS));
  expect([report.stage, report.error]).toEqual(['inventory', undefined]);
});

it('agrees across a layout the export chose, and over a character split between parts', async () => {
  const laid = 'CREATE TABLE sessions (\n  id    TEXT PRIMARY KEY,\n  title TEXT\n)';
  const sql = `${laid};\nINSERT INTO sessions VALUES('s1','héllo… ☃');\n`;
  for (const chunkBytes of [5, 9, 16]) {
    const { report } = await stage(sql, captured(SESSIONS), chunkBytes);
    expect({ chunkBytes, stage: report.stage }).toEqual({ chunkBytes, stage: 'inventory' });
  }
});

it('refuses an export whose text cannot be split', async () => {
  // A NUL outside a text literal is not export text an import would accept either.
  const nul = await stage(`${SESSIONS};\nINSERT INTO sessions VALUES('s1',\u0000);\n`, captured(SESSIONS));
  expect([nul.report.stage, nul.report.error]).toEqual(['failed', 'export_unparsable']);
  // Export text ending inside a quoted value is refused as the reading closes, never taken as whole.
  const open = await stage(`${SESSIONS};\nINSERT INTO sessions VALUES('s1','held`, captured(SESSIONS));
  expect([open.report.stage, open.report.error]).toEqual(['failed', 'export_unparsable']);
});

it('keeps every quoted byte of a definition, so a value that differs is a different definition', () => {
  const pairs: Array<[string, string]> = [
    ["CREATE TABLE t (a TEXT DEFAULT 'a  b')", "CREATE TABLE t (a TEXT DEFAULT 'a b')"],
    ["CREATE TABLE t (a TEXT DEFAULT 'a, b')", "CREATE TABLE t (a TEXT DEFAULT 'a,b')"],
    ['CREATE TABLE t ("a  b" TEXT)', 'CREATE TABLE t ("a b" TEXT)'],
    ["CREATE TABLE t (a TEXT DEFAULT '(x)')", "CREATE TABLE t (a TEXT DEFAULT '( x )')"],
    ['CREATE TABLE t (`a b` TEXT)', 'CREATE TABLE t (`a  b` TEXT)'],
  ];
  for (const [left, right] of pairs) {
    expect({ left, equal: normalizeDefinition(left) === normalizeDefinition(right) }).toEqual({ left, equal: false });
    expect(definitionsDisagree(captured(left), captured(right))).toMatchObject({ changed: 1, missing: 0, extra: 0 });
  }
  // Layout outside quoted text carries no meaning, so the same definition laid out differently still agrees.
  expect(normalizeDefinition('CREATE TABLE t (\n  a TEXT ,\n b TEXT\n)'))
    .toBe(normalizeDefinition('CREATE TABLE t(a TEXT, b TEXT)'));
  expect(definitionsDisagree(captured('CREATE TABLE t (a TEXT)'), captured('CREATE TABLE t(a TEXT)'))).toBeNull();
});

it('reads the captured definitions from the schema a Deployment answers, and names no other object', () => {
  const schema = [
    { type: 'table', name: 'sessions', sql: SESSIONS, storage: 'table' },
    { type: 'index', name: 'sessions_title', sql: 'CREATE INDEX sessions_title ON sessions(title)', storage: null },
    { type: 'table', name: 'search', sql: "CREATE VIRTUAL TABLE search USING fts5(title, content='sessions')", storage: 'virtual' },
    { type: 'view', name: 'recent', sql: 'CREATE VIEW recent AS SELECT * FROM sessions', storage: 'view' },
  ];
  expect(Object.keys(capturedDefinitions(schema))).toEqual(['sessions']);
  expect(capturedDefinitions(schema).sessions).toBe(normalizeDefinition(SESSIONS));
});

it('records an attempt only after its schema and manifest are both staged', async () => {
  const written: string[] = [];
  const recorded: number[] = [];
  const publication = {
    prefix: 'staging/7', target: 'test-target', locator: 'account/database', startedAt: 1_000,
    schema: { sha256: 'a'.repeat(64), bytes: 12 }, schemaText: '[]',
    configuration: { startedBy: 'owner-1' }, credentialsRequired: [],
  };
  const port = (fails: string | null): ProducerPorts => ({
    now: () => 0,
    async pollExport() { throw new Error('publication polls nothing'); },
    async readRange() { throw new Error('publication reads nothing'); },
    async beginUpload() { return 'upload-1'; },
    async writePart() { return { sha256: '', etag: '' }; },
    async completeUpload() { return null; },
    async abortUpload() {},
    async readStoredRange() { return null; },
    async storedSize() { return null; },
    async readStagedPart() { throw new Error('this stage reads no staged part'); },
    async digest() { throw new Error('this stage takes no digest'); },
    async copyObject() { throw new Error('this stage copies no object'); },
    async readStagingFile() { return null; },
    async writeStagingFile(_prefix, name) {
      written.push(name);
      if (name === fails) throw new Error('the staging store refused a write');
    },
  });

  for (const fails of ['schema.json', 'recovery.json']) {
    written.length = 0;
    await expect(publishAttempt(port(fails), publication, () => { recorded.push(1); })).rejects.toThrow('refused a write');
    expect({ fails, written, recorded }).toEqual({ fails, written: written.slice(), recorded: [] });
  }
  written.length = 0;
  await publishAttempt(port(null), publication, () => { recorded.push(1); });
  // Both files are staged, in that order, before the attempt exists at all.
  expect(written).toEqual(['schema.json', 'recovery.json']);
  expect(recorded).toEqual([1]);
});

it('carries a bounded reading across parts, whatever the export pads a statement with', async () => {
  const padding = ' '.repeat(200_000);
  const sql = `${SESSIONS};\n${padding}INSERT INTO sessions VALUES('s1','${'x'.repeat(300_000)}');\n${padding}`;
  const { report, state } = await stage(sql, captured(SESSIONS), 64 * 1024);
  expect([report.stage, Object.keys(state.state.defined)]).toEqual(['inventory', ['sessions']]);
  // What a checkpoint stores between parts stays small, so a padded or oversized statement cannot fill it.
  expect(JSON.stringify({ scan: state.state.scan, bytes: state.state.scanBytes }).length).toBeLessThan(4_096);
});
