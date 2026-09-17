/**
 * The stages that turn a staged export into a complete staging: the inventory its own rows name, the copy of every
 * object that inventory registers, and the manifest written only once all of it is verified.
 *
 * What the checkpoint holds is proven here as plain data; the Durable Object's own storage and the clock's
 * continuation are proven separately under wrangler dev.
 */
import { expect, it } from 'bun:test';
import {
  ADVANCING_STAGES, continueAttempt, freshScan, PRODUCER_LIMITS, reconcileUnconfirmed,
  type AttemptCheckpoint, type AttemptObject, type AttemptPart, type AttemptState, type CopyAnswer,
  type ProducerPorts, type ScanProgress,
} from '@myco-server-worker/core/recovery-producer.js';
import { newInventoryProgress, type InventoryObject, type InventoryProgress } from '@myco-server-worker/core/recovery-inventory.js';
import { STAGING_MANIFEST_FILE, STAGING_OBJECTS_DIRECTORY, stagingPath } from '@myco-server-worker/core/recovery-staging.js';

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

const BLOBS_DDL = 'CREATE TABLE blobs (project_id TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, media_type TEXT NOT NULL, token_id TEXT NOT NULL, received_at INTEGER NOT NULL, PRIMARY KEY (project_id, key))';
const BACKUPS_DDL = 'CREATE TABLE backups (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, counts_json TEXT NOT NULL, schema_version INTEGER NOT NULL, producer TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, sha256 TEXT)';
const digest = (seed: string): string => seed.repeat(64).slice(0, 64);

/** One blob and two catalogued backups, one of them a row that records no digest. */
const EXPORT = [
  'PRAGMA defer_foreign_keys=TRUE;',
  `${BLOBS_DDL};`,
  `${BACKUPS_DDL};`,
  'CREATE TABLE events (project_id TEXT NOT NULL, event_id TEXT NOT NULL, payload TEXT NOT NULL);',
  `INSERT INTO blobs VALUES('proj_1','${digest('a')}',11,'text/plain','tok_1',1789590000000);`,
  "INSERT INTO events VALUES('proj_1','ev_1','a prompt holding INSERT INTO blobs VALUES(0)');",
  `INSERT INTO backups VALUES('bk_1','backups/one.jsonl',1789590000000,22,'{}',41,'myco',0,'${digest('b')}');`,
  "INSERT INTO backups VALUES('bk_2','backups/two.jsonl',1789590000001,33,'{}',41,'myco',0,NULL);",
  '',
].join('\n');

const OBJECTS: Record<string, number> = {
  [`proj_1/${digest('a')}`]: 11,
  'backups/one.jsonl': 22,
  'backups/two.jsonl': 33,
};

const ADMITTED = JSON.stringify({
  format: 'myco-recovery/3',
  source: { target: 'cloudflare', locator: 'account-1/database-1' },
  status: 'open',
  startedAt: '2026-09-16T00:00:00.000Z',
  schema: { sha256: digest('c'), bytes: 120 },
  configuration: { startedBy: 'mem_1' },
  credentialsRequired: ['MYCO_WRAP_KEY'],
  objects: [],
});

/** The admission the checkpoint owner records with the attempt, which is exactly what `ADMITTED` publishes. */
const RECORDED = (({ source, startedAt, schema, configuration, credentialsRequired }) => ({ source, startedAt, schema, configuration, credentialsRequired }))(JSON.parse(ADMITTED));

/** A checkpoint in memory, holding objects beside the attempt exactly as the hosted store keeps them. */
function checkpoint(initial: Partial<AttemptState> = {}) {
  const fresh = newInventoryProgress();
  const state: AttemptState = {
    id: 1, stage: 'inventory', prefix: 'staging/1', startedAt: 0, error: null, attempts: 0, bookmark: 'b2', polls: 1,
    exportStartedAt: 0, exportCompletedAt: 0, reExports: 0, sqlBytes: null, sqlEtag: 'w/"one"', uploadId: null,
    downloadOffset: 0, reconcileOffset: 0, reconciled: 1, tables: ['blobs', 'backups', 'events'],
    captured: { blobs: BLOBS_DDL, backups: BACKUPS_DDL },
    inventoryStartedAt: null, inventoryParts: 0, inventoryBytes: 0, inventoryScan: fresh.scan, inventoryScanBytes: '',
    inventoryDigest: null, databaseSha256: null, databaseBytes: null, copyStartedAt: null, completedAt: null,
    admission: RECORDED,
    ...freshScan(), ...initial,
  };
  const store = {
    state,
    held: [] as AttemptPart[],
    signed: null as string | null,
    objectRows: [] as AttemptObject[],
    commits: 0,
    open: () => ((ADVANCING_STAGES as readonly string[]).includes(store.state.stage) ? { ...store.state } : null),
    update: (_id: number, fields: Partial<AttemptState>) => { Object.assign(store.state, fields); },
    parts: () => [...store.held].sort((left, right) => left.part - right.part),
    recordPart: (_id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress) => {
      store.held = [...store.held.filter((held) => held.part !== part.part), part];
      Object.assign(store.state, progress, { downloadOffset });
    },
    clearParts: () => { store.held = []; },
    recordInventory: (_id: number, progress: InventoryProgress, objects: readonly InventoryObject[]) => {
      store.commits += 1;
      for (const object of objects) {
        const already = store.objectRows.find((held) => held.key === object.key);
        if (already === undefined) store.objectRows.push({ ...object, stagedSha256: null, stagedBytes: null });
        else Object.assign(already, { bytes: object.bytes, sha256: object.sha256 });
      }
      Object.assign(store.state, {
        inventoryParts: progress.parts, inventoryBytes: progress.bytes, inventoryScan: progress.scan,
        inventoryScanBytes: progress.scanBytes, inventoryDigest: progress.digest,
      });
    },
    pendingObjects: (_id: number, limit: number) => store.objectRows.filter((held) => held.stagedSha256 === null).slice(0, limit),
    recordCopied: (_id: number, key: string, staged: { sha256: string; bytes: number }) => {
      const held = store.objectRows.find((object) => object.key === key);
      if (held !== undefined) Object.assign(held, { stagedSha256: staged.sha256, stagedBytes: staged.bytes });
    },
    objects: () => [...store.objectRows].sort((left, right) => (left.key < right.key ? -1 : 1)),
    objectCounts: () => ({
      registered: store.objectRows.length,
      staged: store.objectRows.filter((held) => held.stagedSha256 !== null).length,
    }),
    signedUrl: async () => store.signed,
    setSignedUrl: async (_id: number, url: string | null) => { store.signed = url; },
  };
  return store as typeof store & AttemptCheckpoint;
}

interface StoreOptions {
  copyObject?: (key: string, expected: { bytes: number; sha256: string | null }, signal: AbortSignal) => Promise<CopyAnswer>;
  writeStagingFile?: (name: string, body: string, signal?: AbortSignal) => Promise<void>;
  readStagingFile?: (name: string, held: string | null) => Promise<string | null>;
  now?: () => number;
  export?: string;
}

/** A staged export in a store the stages read through their ports, cut into recorded parts. */
async function staged(options: StoreOptions = {}, partBytes = 128) {
  const bytes = new TextEncoder().encode(options.export ?? EXPORT);
  const parts: AttemptPart[] = [];
  for (let at = 0, part = 1; at < bytes.byteLength; at += partBytes, part += 1) {
    const slice = bytes.subarray(at, Math.min(at + partBytes, bytes.byteLength));
    parts.push({ part, bytes: slice.byteLength, sha256: await digestOf(slice), etag: `etag-${part}` });
  }
  const files: Record<string, string> = { [STAGING_MANIFEST_FILE]: ADMITTED };
  const calls = { reads: [] as number[], copies: [] as string[], writes: [] as string[] };
  const port: ProducerPorts = {
    now: options.now ?? (() => 0),
    async pollExport() { throw new Error('the staging stages poll no export'); },
    async readRange() { throw new Error('the staging stages read no signed range'); },
    async writePart() { throw new Error('the staging stages write no export part'); },
    async beginUpload() { throw new Error('the staging stages begin no upload'); },
    async completeUpload() { return null; },
    async abortUpload() {},
    async readStoredRange() { return null; },
    async storedSize() { return bytes.byteLength; },
    async readStagedPart(_prefix, offset, count) {
      calls.reads.push(offset);
      return bytes.subarray(offset, offset + count);
    },
    digest: (value) => digestOf(value),
    async copyObject(_prefix, { key }, expected, signal) {
      calls.copies.push(key);
      if (options.copyObject !== undefined) return options.copyObject(key, expected, signal);
      const held = new Uint8Array(expected.bytes).fill(7);
      return { status: 'copied', sha256: expected.sha256 ?? await digestOf(held), bytes: expected.bytes };
    },
    async writeStagingFile(_prefix, name, body, signal) {
      calls.writes.push(name);
      if (options.writeStagingFile !== undefined) await options.writeStagingFile(name, body, signal);
      files[name] = body;
    },
    async readStagingFile(_prefix, name) {
      if (options.readStagingFile !== undefined) return options.readStagingFile(name, files[name] ?? null);
      return files[name] ?? null;
    },
  };
  return { bytes, parts, port, calls, files, sha256: await digestOf(bytes) };
}

const started = (held: Awaited<ReturnType<typeof staged>>, initial: Partial<AttemptState> = {}) => {
  const state = checkpoint({ sqlBytes: held.bytes.byteLength, ...initial });
  state.held = [...held.parts];
  return state;
};

/** Runs continuations until the attempt settles, so a bounded stage is driven the way the clock drives it. */
async function settle(state: ReturnType<typeof checkpoint>, port: ProducerPorts, limits = PRODUCER_LIMITS) {
  let last = await continueAttempt(state, port, limits);
  for (let step = 0; step < 64 && last.nextInMs !== null; step += 1) {
    last = await continueAttempt(state, port, limits);
  }
  return last;
}

it('reads the inventory, copies every object it names, and completes the staging once', async () => {
  const held = await staged();
  const state = started(held);
  const report = await settle(state, held.port);

  expect([report.stage, report.nextInMs, report.error]).toEqual(['complete', null, undefined]);
  // The fingerprint is the digest of the staged bytes, over the parts the download recorded.
  expect([state.state.databaseSha256, state.state.databaseBytes]).toEqual([held.sha256, held.bytes.byteLength]);
  // All and only the objects the export's own rows register, each copied once.
  expect(held.calls.copies.sort()).toEqual(Object.keys(OBJECTS).sort());
  expect(state.objectCounts()).toEqual({ registered: 3, staged: 3 });

  const manifest = JSON.parse(held.files[STAGING_MANIFEST_FILE]!) as Record<string, unknown>;
  expect(manifest.status).toBe('complete');
  expect(manifest.completedAt).toBe('1970-01-01T00:00:00.000Z');
  expect(manifest.database).toEqual({ sha256: held.sha256, bytes: held.bytes.byteLength });
  expect(manifest.exportBookmark).toBe('b2');
  // What admission published is kept, not written again.
  expect(manifest.schema).toEqual({ sha256: digest('c'), bytes: 120 });
  expect(manifest.configuration).toEqual({ startedBy: 'mem_1' });
  expect(manifest.credentialsRequired).toEqual(['MYCO_WRAP_KEY']);
  // Every object carries a digest, including the catalogued backup whose row records none.
  expect(manifest.objects).toEqual([
    { key: 'backups/one.jsonl', bytes: 22, sha256: digest('b') },
    { key: 'backups/two.jsonl', bytes: 33, sha256: await digestOf(new Uint8Array(33).fill(7)) },
    { key: `proj_1/${digest('a')}`, bytes: 11, sha256: digest('a') },
  ]);
  // The manifest is the only staging file this slice writes, and it is written once.
  expect(held.calls.writes).toEqual([STAGING_MANIFEST_FILE]);
});

it('bounds each continuation, and carries the inventory cursor and digest across them', async () => {
  const held = await staged({}, 64);
  const state = started(held);
  const hashed: number[] = [];
  let report = await continueAttempt(state, held.port, { ...PRODUCER_LIMITS, maxPartsPerStep: 1, maxObjectsPerStep: 1 });
  for (let step = 0; step < 64 && report.nextInMs !== null; step += 1) {
    if (state.state.stage === 'inventory') hashed.push(state.state.inventoryDigest?.bytesHashed ?? -1);
    report = await continueAttempt(state, held.port, { ...PRODUCER_LIMITS, maxPartsPerStep: 1, maxObjectsPerStep: 1 });
  }
  expect(report.stage).toBe('complete');
  // One part per continuation, and the digest's own count follows the cursor it is committed with.
  expect(hashed.length).toBeGreaterThan(1);
  expect(hashed).toEqual(hashed.map((_value, index) => held.parts.slice(0, index + 1).reduce((sum, part) => sum + part.bytes, 0)));
  // Each part is read once for the whole pass, however many continuations it takes.
  expect(held.calls.reads.length).toBe(held.parts.length);
});

it('refuses an object the store no longer holds, and one whose copy does not match its row', async () => {
  const missing = await staged({ copyObject: async (key) => (key === 'backups/one.jsonl' ? { status: 'missing' } : { status: 'copied', sha256: digest('a'), bytes: 11 }) });
  const gone = await settle(started(missing), missing.port);
  expect([gone.stage, gone.error]).toEqual(['failed', 'object_missing']);

  // A copy whose own digest disagrees with the digest the source row records is refused, not recorded.
  const changed = await staged({ copyObject: async (_key, expected) => ({ status: 'copied', sha256: digest('f'), bytes: expected.bytes }) });
  const state = started(changed);
  const refused = await settle(state, changed.port);
  expect([refused.stage, refused.error]).toEqual(['failed', 'object_changed']);
  expect(state.objectCounts().staged).toBe(0);
  expect(changed.files[STAGING_MANIFEST_FILE]).toBe(ADMITTED);

  // A copy of the recorded digest but the wrong length is refused on its size alone.
  const short = await staged({ copyObject: async (_key, expected) => ({ status: 'copied', sha256: expected.sha256 ?? digest('b'), bytes: expected.bytes - 1 }) });
  const shrunk = await settle(started(short), short.port);
  expect([shrunk.stage, shrunk.error]).toEqual(['failed', 'object_changed']);
});

it('completes nothing while an object is unstaged, whatever else is verified', async () => {
  const held = await staged();
  const state = started(held);
  // The inventory runs to its end, then a copy that stages nothing: the stage cannot finish and writes no manifest.
  for (let step = 0; step < 16 && state.state.stage === 'inventory'; step += 1) {
    await continueAttempt(state, held.port, PRODUCER_LIMITS);
  }
  expect(state.state.stage).toBe('copy');
  const stuck = await continueAttempt(state, held.port, { ...PRODUCER_LIMITS, maxObjectsPerStep: 0 });
  expect([stuck.stage, stuck.progressed, stuck.nextInMs]).toEqual(['copy', false, 0]);
  expect(held.calls.writes).toEqual([]);
  expect(held.files[STAGING_MANIFEST_FILE]).toBe(ADMITTED);
});

it('republishes the same manifest after an interruption between the write and the commit', async () => {
  // The write lands and the continuation is lost before the stage is committed.
  let written = 0;
  const held = await staged({
    now: () => 1_700_000_000_000,
    writeStagingFile: async () => {
      written += 1;
      if (written === 1) throw new Error('the continuation ended after the write');
    },
  });
  const state = started(held);
  let lost = await continueAttempt(state, held.port, PRODUCER_LIMITS);
  for (let step = 0; step < 32 && written === 0; step += 1) {
    lost = await continueAttempt(state, held.port, PRODUCER_LIMITS);
  }
  // The write landed and the continuation ended before the commit, so the attempt still stands at its copy stage.
  expect([written, lost.stage, state.state.stage]).toEqual([1, 'copy', 'copy']);
  // The completion time is durable before the manifest names it, so nothing about it is chosen twice.
  expect(state.state.completedAt).toBe(1_700_000_000_000);

  const resumed = await settle(state, held.port);
  expect(resumed.stage).toBe('complete');
  expect(written).toBe(2);
  const manifest = JSON.parse(held.files[STAGING_MANIFEST_FILE]!) as Record<string, unknown>;
  expect(manifest.completedAt).toBe(new Date(1_700_000_000_000).toISOString());
  // A published staging is never lost and never published as a second, different staging.
  expect(state.objectCounts()).toEqual({ registered: 3, staged: 3 });
});

it('refuses to complete a staging whose admission it cannot read back', async () => {
  const held = await staged();
  delete held.files[STAGING_MANIFEST_FILE];
  const report = await settle(started(held), held.port);
  expect([report.stage, report.error]).toEqual(['failed', 'staging_incomplete']);
});

it('refuses a staged export whose bytes no longer match the parts the download recorded', async () => {
  const held = await staged();
  const state = started(held);
  const substituted: ProducerPorts = {
    ...held.port,
    async readStagedPart(prefix, offset, count) {
      const read = (await held.port.readStagedPart(prefix, offset, count, new AbortController().signal))!.slice();
      if (offset > 0) read[0] = read[0]! ^ 0x20;
      return read;
    },
  };
  const report = await settle(state, substituted);
  expect([report.stage, report.error]).toEqual(['failed', 'staging_changed']);
  expect(held.calls.writes).toEqual([]);
});

it('names every staged object under the objects directory of its own staging', () => {
  // The key the manifest lists and the key the object is written under are the same key.
  expect(stagingPath('staging/1', STAGING_OBJECTS_DIRECTORY, `proj_1/${digest('a')}`))
    .toBe(`staging/1/objects/proj_1/${digest('a')}`);
  expect(stagingPath('staging/1', STAGING_OBJECTS_DIRECTORY, 'backups/one.jsonl'))
    .toBe('staging/1/objects/backups/one.jsonl');
});

/** Drives the inventory to its end, so a test begins at the copy stage with every object registered. */
async function atCopy(held: Awaited<ReturnType<typeof staged>>, clock: { now: number }) {
  const state = started(held);
  for (let step = 0; step < 16 && state.state.stage === 'inventory'; step += 1) {
    await continueAttempt(state, held.port, PRODUCER_LIMITS);
  }
  expect(state.state.stage).toBe('copy');
  clock.now = 0;
  return state;
}

it('bounds a copy that never settles, tells the port to stop, and records nothing', async () => {
  const clock = { now: 0 };
  let aborted = 0;
  const held = await staged({
    now: () => clock.now,
    copyObject: (_key, _expected, signal) => new Promise(() => { signal.addEventListener('abort', () => { aborted += 1; }); }),
  });
  const state = await atCopy(held, clock);
  const began = Date.now();
  const report = await continueAttempt(state, held.port, { ...PRODUCER_LIMITS, objectMs: 20 });
  // The deadline owner answers, the port is told to stop, and the copy is spent as one transient failure.
  expect(Date.now() - began).toBeLessThan(1_000);
  expect([report.stage, report.nextInMs, report.error, aborted]).toEqual(['copy', 1_000, 'provider_unavailable', 1]);
  expect([state.state.attempts, state.objectCounts().staged, held.calls.writes]).toEqual([1, 0, []]);
});

it('never records a copy that settles past its budget, and ends the attempt once the copy budget is spent', async () => {
  // Past the object's own deadline but inside the stage budget: spent as transient, not recorded.
  const slow = { now: 0 };
  const late = await staged({
    now: () => slow.now,
    copyObject: async (_key, expected) => { slow.now += 500; return { status: 'copied', sha256: expected.sha256 ?? digest('d'), bytes: expected.bytes }; },
  });
  const lateState = await atCopy(late, slow);
  const spent = await continueAttempt(lateState, late.port, { ...PRODUCER_LIMITS, objectMs: 100 });
  expect([spent.stage, spent.error, lateState.objectCounts().staged]).toEqual(['copy', 'provider_unavailable', 0]);

  // A copy that settles past what the stage budget has left ends the attempt before anything is published.
  const spentClock = { now: 0 };
  const over = await staged({
    now: () => spentClock.now,
    copyObject: async (_key, expected) => { spentClock.now = 1_000; return { status: 'copied', sha256: expected.sha256 ?? digest('d'), bytes: expected.bytes }; },
  });
  const overState = await atCopy(over, spentClock);
  const ended = await continueAttempt(overState, over.port, { ...PRODUCER_LIMITS, copyMs: 10 });
  expect([ended.stage, ended.error, overState.objectCounts().staged]).toEqual(['failed', 'copy_stalled', 0]);
  expect([over.calls.writes, over.files[STAGING_MANIFEST_FILE]]).toEqual([[], ADMITTED]);
});

it('confirms a publication whose write settled late, without failing it and without writing it again', async () => {
  const clock = { now: 0 };
  const held = await staged({
    now: () => clock.now,
    // The manifest lands, and the write answers only after its deadline.
    writeStagingFile: async () => { clock.now += 1_000; },
  });
  const state = await atCopy(held, clock);
  const limits = { ...PRODUCER_LIMITS, requestMs: 10 };
  let report = await continueAttempt(state, held.port, limits);
  for (let step = 0; step < 8 && held.calls.writes.length === 0; step += 1) report = await continueAttempt(state, held.port, limits);
  expect([report.stage, report.error, state.state.stage]).toEqual(['copy', 'provider_unavailable', 'copy']);
  expect(JSON.parse(held.files[STAGING_MANIFEST_FILE]!).status).toBe('complete');

  // The next continuation reads the manifest back as exactly the body it wrote, and completes.
  const confirmed = await continueAttempt(state, held.port, limits);
  expect([confirmed.stage, confirmed.error, state.state.stage]).toEqual(['complete', undefined, 'complete']);
  expect(held.calls.writes).toEqual([STAGING_MANIFEST_FILE]);
});

it('never claims a publication failed while a write of it may still land, and settles it once it reads back', async () => {
  // The write is sent and held past its deadline and past the whole window, then lands: a write cannot be withdrawn.
  const clock = { now: 0 };
  let deliver: (() => void) | undefined;
  const held = await staged({ now: () => clock.now });
  const state = await atCopy(held, clock);
  const write = held.port.writeStagingFile;
  held.port.writeStagingFile = (...args) => new Promise<void>((resolve) => { deliver = () => { void write(...args).then(resolve); }; });
  const limits = { ...PRODUCER_LIMITS, requestMs: 5, publishMs: 10 };

  const first = await continueAttempt(state, held.port, limits);
  expect([first.stage, first.error, state.state.stage]).toEqual(['copy', 'provider_unavailable', 'copy']);
  clock.now = 20;
  const second = await continueAttempt(state, held.port, limits);
  // Past the window the staging still reads open, which proves nothing about the write on its way.
  expect([second.stage, second.nextInMs, second.error, state.state.stage, state.state.error]).toEqual(['unconfirmed', null, undefined, 'unconfirmed', null]);
  // Resting unconfirmed holds back no new attempt.
  expect(state.open()).toBeNull();

  deliver?.();
  await Bun.sleep(5);
  expect(JSON.parse(held.files[STAGING_MANIFEST_FILE]!).status).toBe('complete');
  // One bounded read settles it: the manifest that landed is exactly the one this attempt wrote.
  expect(await reconcileUnconfirmed({ ...state.state }, state, held.port, limits)).toBe('complete');
  expect(state.state.stage).toBe('complete');
});

it('rests unconfirmed past the window when nothing can be read, and reconciles nothing it did not write', async () => {
  const clock = { now: 0 };
  let readable = true;
  const dark = await staged({
    now: () => clock.now,
    writeStagingFile: async () => { readable = false; throw new Error('the continuation ended during the write'); },
    readStagingFile: async (_name, held) => { if (!readable) throw new Error('the staging store cannot be read'); return held; },
  });
  const state = await atCopy(dark, clock);
  const limits = { ...PRODUCER_LIMITS, publishMs: 5_000 };
  await continueAttempt(state, dark.port, limits);
  for (const at of [1_000, 4_000]) {
    clock.now = at;
    const pending = await continueAttempt(state, dark.port, limits);
    expect({ at, stage: pending.stage, error: pending.error }).toEqual({ at, stage: 'copy', error: 'provider_unavailable' });
  }
  // Inside the window nothing is spent: the window, not the transient budget, bounds an unconfirmed publication.
  expect(state.state.attempts).toBe(0);
  clock.now = 9_000;
  const resting = await continueAttempt(state, dark.port, limits);
  expect([resting.stage, resting.error, state.state.stage]).toEqual(['unconfirmed', undefined, 'unconfirmed']);

  // Still unreadable, or readable as anything but this attempt's own manifest: it rests as it was.
  expect(await reconcileUnconfirmed({ ...state.state }, state, dark.port, limits)).toBe('unconfirmed');
  readable = true;
  dark.files[STAGING_MANIFEST_FILE] = JSON.stringify({ ...JSON.parse(ADMITTED), status: 'complete', completedAt: '2026-09-16T00:00:00.000Z' });
  expect(await reconcileUnconfirmed({ ...state.state }, state, dark.port, limits)).toBe('unconfirmed');
  expect(state.state.stage).toBe('unconfirmed');
});

it('refuses a staging another completion already published, and publishes nothing past the copy budget', async () => {
  const foreign = JSON.stringify({ ...JSON.parse(ADMITTED), status: 'complete', completedAt: '2026-09-16T00:00:00.000Z' });
  const clock = { now: 0 };
  const held = await staged({ now: () => clock.now });
  const state = await atCopy(held, clock);
  held.files[STAGING_MANIFEST_FILE] = foreign;
  const changed = await continueAttempt(state, held.port, PRODUCER_LIMITS);
  expect([changed.stage, changed.error, held.calls.writes]).toEqual(['failed', 'staging_changed', []]);

  // Every copy staged, and the budget spent before any completion time is recorded: nothing is published.
  const late = { now: 0 };
  const budget = await staged({ now: () => late.now });
  const budgetState = await atCopy(budget, late);
  budgetState.state.copyStartedAt = 0;
  for (const object of budgetState.objects()) budgetState.recordCopied(1, object.key, { sha256: object.sha256 ?? digest('d'), bytes: object.bytes });
  late.now = 5_000;
  const ended = await continueAttempt(budgetState, budget.port, { ...PRODUCER_LIMITS, copyMs: 10, maxObjectsPerStep: 99 });
  expect([ended.stage, ended.error]).toEqual(['failed', 'copy_stalled']);
  expect([budget.calls.writes, budgetState.state.completedAt]).toEqual([[], null]);
});

/** One field of a published manifest changed, as a substituted staging would carry it. */
const ALTERATIONS: ReadonlyArray<[string, (manifest: Record<string, any>) => void]> = [
  ['source.target', (manifest) => { manifest.source.target = 'local'; }],
  ['source.locator', (manifest) => { manifest.source.locator = 'different-account/different-database'; }],
  ['startedAt', (manifest) => { manifest.startedAt = '2026-09-17T00:00:00.000Z'; }],
  ['schema.sha256', (manifest) => { manifest.schema.sha256 = 'f'.repeat(64); }],
  ['schema.bytes', (manifest) => { manifest.schema.bytes += 1; }],
  ['configuration', (manifest) => { manifest.configuration = { startedBy: 'mem_other' }; }],
  ['credentialsRequired', (manifest) => { manifest.credentialsRequired = []; }],
  ['exportBookmark', (manifest) => { manifest.exportBookmark = 'b9'; }],
  ['completedAt', (manifest) => { manifest.completedAt = '2026-09-17T00:00:00.000Z'; }],
  ['database.sha256', (manifest) => { manifest.database.sha256 = 'e'.repeat(64); }],
  ['objects[0].sha256', (manifest) => { manifest.objects[0].sha256 = 'd'.repeat(64); }],
];

/** Drives one attempt until its manifest lands late and it rests unconfirmed, with the exact manifest published. */
async function restingWithLateManifest() {
  const clock = { now: 0 };
  let deliver: (() => void) | undefined;
  const held = await staged({ now: () => clock.now });
  const state = await atCopy(held, clock);
  const write = held.port.writeStagingFile;
  held.port.writeStagingFile = (...args) => new Promise<void>((resolve) => { deliver = () => { void write(...args).then(resolve); }; });
  const limits = { ...PRODUCER_LIMITS, requestMs: 5, publishMs: 10 };
  await continueAttempt(state, held.port, limits);
  clock.now = 20;
  await continueAttempt(state, held.port, limits);
  deliver?.();
  await Bun.sleep(5);
  held.port.writeStagingFile = write;
  expect(state.state.stage).toBe('unconfirmed');
  return { held, state, limits, exact: held.files[STAGING_MANIFEST_FILE]! };
}

it('holds a late manifest to the admission the checkpoint recorded, field by field, and never to itself', async () => {
  for (const [field, alter] of ALTERATIONS) {
    const { held, state, limits, exact } = await restingWithLateManifest();
    const changed = JSON.parse(exact) as Record<string, any>;
    alter(changed);
    // The alteration is serialized exactly as a publication is, so only the changed field differs.
    held.files[STAGING_MANIFEST_FILE] = JSON.stringify(changed, null, 2);
    const reconciled = await reconcileUnconfirmed({ ...state.state }, state, held.port, limits);
    expect({ field, reconciled, stage: state.state.stage }).toEqual({ field, reconciled: 'unconfirmed', stage: 'unconfirmed' });
  }
  // The exact manifest this attempt wrote still settles it.
  const { held, state, limits } = await restingWithLateManifest();
  expect(await reconcileUnconfirmed({ ...state.state }, state, held.port, limits)).toBe('complete');
});

it('refuses a changed manifest when a publication is retried inside its window, field by field', async () => {
  for (const [field, alter] of ALTERATIONS) {
    const clock = { now: 0 };
    let sent = 0;
    const held = await staged({
      now: () => clock.now,
      // The first write lands and its answer never comes in time, so the next continuation retries.
      writeStagingFile: async () => { sent += 1; if (sent === 1) clock.now += 50; },
    });
    const state = await atCopy(held, clock);
    const limits = { ...PRODUCER_LIMITS, requestMs: 10 };
    let report = await continueAttempt(state, held.port, limits);
    for (let step = 0; step < 8 && sent === 0; step += 1) report = await continueAttempt(state, held.port, limits);
    expect({ field, stage: report.stage }).toEqual({ field, stage: 'copy' });
    const changed = JSON.parse(held.files[STAGING_MANIFEST_FILE]!) as Record<string, any>;
    alter(changed);
    held.files[STAGING_MANIFEST_FILE] = JSON.stringify(changed, null, 2);
    const retried = await continueAttempt(state, held.port, limits);
    expect({ field, stage: retried.stage, error: retried.error }).toEqual({ field, stage: 'failed', error: 'staging_changed' });
  }
});
