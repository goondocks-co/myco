/**
 * The producer's stage machine, over a checkpoint and ports a test supplies: what it advances, what it refuses, and
 * what it never claims. No provider, no workerd; the runtime behaviour of the checkpoint object and the clock's
 * continuation is proven separately under wrangler dev.
 */
import { expect, it } from 'bun:test';
import {
  ADVANCING_STAGES, continueAttempt, freshScan, PRODUCER_LIMITS, TransientProducerFailure,
  type AttemptCheckpoint, type AttemptObject, type AttemptPart, type AttemptState, type CopyAnswer,
  type ExportAnswer, type PortFailure, type ProducerPorts, type RangeAnswer, type ScanProgress,
} from '@myco-server-worker/core/recovery-producer.js';
import { newInventoryProgress, type InventoryObject, type InventoryProgress } from '@myco-server-worker/core/recovery-inventory.js';

const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};

/** A checkpoint in memory, with the same durability rules the hosted object's storage gives the real one. */
function checkpoint(initial: Partial<AttemptState> = {}): AttemptCheckpoint & {
  state: AttemptState; held: AttemptPart[]; signed: string | null; staged: AttemptObject[];
} {
  const fresh = newInventoryProgress();
  const state: AttemptState = {
    id: 1, stage: 'export', prefix: 'staging/1', startedAt: 0, error: null, attempts: 0, bookmark: null, polls: 0,
    exportStartedAt: null, exportCompletedAt: null, reExports: 0, sqlBytes: null, sqlEtag: null, uploadId: null,
    downloadOffset: 0, reconcileOffset: 0, reconciled: 0, tables: ['sessions'], captured: {},
    inventoryStartedAt: null, inventoryParts: 0, inventoryBytes: 0, inventoryScan: fresh.scan, inventoryScanBytes: '',
    inventoryDigest: null, databaseSha256: null, databaseBytes: null, copyStartedAt: null, completedAt: null,
    admission: { source: { target: 'cloudflare', locator: 'account-1/database-1' }, startedAt: '1970-01-01T00:00:00.000Z', schema: { sha256: 'c'.repeat(64), bytes: 1 }, configuration: {}, credentialsRequired: [] },
    ...freshScan(), ...initial,
  };
  const store = {
    state,
    held: [] as AttemptPart[],
    signed: null as string | null,
    // A fresh object per read, as the hosted checkpoint's row reader answers: an update never reaches a state a
    // caller already holds.
    open: () => ((ADVANCING_STAGES as readonly string[]).includes(store.state.stage) ? { ...store.state } : null),
    update: (_id: number, fields: Partial<AttemptState>) => { Object.assign(store.state, fields); },
    parts: () => [...store.held].sort((left, right) => left.part - right.part),
    recordPart: (_id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress) => {
      store.held = [...store.held.filter((held) => held.part !== part.part), part];
      Object.assign(store.state, progress, { downloadOffset });
    },
    clearParts: () => { store.held = []; },
    // The objects live beside the attempt, one to a row, as the hosted checkpoint keeps them.
    staged: [] as AttemptObject[],
    recordInventory: (_id: number, progress: InventoryProgress, objects: readonly InventoryObject[]) => {
      for (const object of objects) {
        const already = store.staged.find((held) => held.key === object.key);
        if (already === undefined) store.staged.push({ ...object, stagedSha256: null, stagedBytes: null });
        else Object.assign(already, { bytes: object.bytes, sha256: object.sha256 });
      }
      Object.assign(store.state, {
        inventoryParts: progress.parts, inventoryBytes: progress.bytes, inventoryScan: progress.scan,
        inventoryScanBytes: progress.scanBytes, inventoryDigest: progress.digest,
      });
    },
    pendingObjects: (_id: number, limit: number) => store.staged.filter((held) => held.stagedSha256 === null).slice(0, limit),
    recordCopied: (_id: number, key: string, staged: { sha256: string; bytes: number }) => {
      const held = store.staged.find((object) => object.key === key);
      if (held !== undefined) Object.assign(held, { stagedSha256: staged.sha256, stagedBytes: staged.bytes });
    },
    objects: () => [...store.staged].sort((left, right) => (left.key < right.key ? -1 : 1)),
    objectCounts: () => ({
      registered: store.staged.length,
      staged: store.staged.filter((held) => held.stagedSha256 !== null).length,
    }),
    signedUrl: async () => store.signed,
    setSignedUrl: async (_id: number, url: string | null) => { store.signed = url; },
  };
  return store;
}

interface PortOptions {
  exports?: ExportAnswer[];
  ranges?: RangeAnswer[];
  completeUpload?: () => Promise<{ bytes: number } | null>;
  storedRange?: (prefix: string, offset: number, length: number) => Promise<{ sha256: string } | null>;
  storedSize?: () => Promise<number | null>;
  now?: () => number;
  stagedParts?: (prefix: string, offset: number, bytes: number) => Promise<Uint8Array | null>;
  copyObject?: (prefix: string, key: string, expected: { bytes: number; sha256: string | null }) => Promise<CopyAnswer>;
  stagingFiles?: Record<string, string>;
}

function ports(options: PortOptions = {}) {
  const calls = {
    polls: 0, ranges: 0, aborted: 0, completed: 0, parts: [] as number[], staged: [] as string[],
    reads: [] as number[], copies: [] as string[], written: {} as Record<string, string>,
  };
  const exports = [...(options.exports ?? [])];
  const ranges = [...(options.ranges ?? [])];
  const port: ProducerPorts = {
    now: options.now ?? (() => 0),
    async pollExport() {
      calls.polls += 1;
      const next = exports.shift();
      if (next === undefined) throw new Error('the test supplied no further export answer');
      return next;
    },
    async readRange() {
      calls.ranges += 1;
      const next = ranges.shift();
      if (next === undefined) throw new Error('the test supplied no further range answer');
      return next;
    },
    async beginUpload() { return 'upload-1'; },
    async writePart(_prefix, _uploadId, part, body) {
      calls.parts.push(part);
      const bytes = body instanceof Uint8Array ? body : new Uint8Array();
      return { sha256: await digestOf(bytes), etag: `etag-${part}` };
    },
    completeUpload: options.completeUpload ?? (async () => { calls.completed += 1; return { bytes: 8 }; }),
    async abortUpload() { calls.aborted += 1; },
    readStoredRange: options.storedRange ?? (async () => null),
    storedSize: options.storedSize ?? (async () => null),
    async writeStagingFile(_prefix, name, body) { calls.staged.push(name); calls.written[name] = body; },
    async readStagingFile(_prefix, name) { return calls.written[name] ?? options.stagingFiles?.[name] ?? null; },
    async readStagedPart(prefix, offset, bytes) {
      calls.reads.push(offset);
      if (options.stagedParts === undefined) throw new Error('the test supplied no staged export');
      return options.stagedParts(prefix, offset, bytes);
    },
    digest: (bytes) => digestOf(bytes),
    async copyObject(prefix, key, expected) {
      calls.copies.push(key);
      if (options.copyObject === undefined) return { status: 'copied', sha256: expected.sha256 ?? await digestOf(body(7, expected.bytes)), bytes: expected.bytes };
      return options.copyObject(prefix, key, expected);
    },
  };
  return { port, calls };
}

const body = (value: number, length = 4): Uint8Array => new Uint8Array(length).fill(value);
const range = (bytes: Uint8Array, total: number, etag = 'w/"one"'): RangeAnswer =>
  ({ status: 'part', bytes, length: bytes.byteLength, total, etag });
const failure = (cause: PortFailure['cause'], status: number | null, transient: boolean): PortFailure => ({ cause, status, transient });

it('polls an export to completion, then stages it in parts and stops short of any recoverable claim', async () => {
  const state = checkpoint();
  const first = body(1);
  const second = body(2);
  const { port, calls } = ports({
    exports: [{ status: 'running', bookmark: 'b1' }, { status: 'complete', bookmark: 'b2', signedUrl: 'https://signed/one' }],
    ranges: [range(first, 8), range(second, 8)],
  });
  const limits = { ...PRODUCER_LIMITS, partBytes: 4 };

  const exporting = await continueAttempt(state, port, limits);
  expect([exporting.stage, exporting.sourcePaused, exporting.nextInMs]).toEqual(['download', false, 0]);
  expect(state.state.bookmark).toBe('b2');
  expect(state.signed).toBe('https://signed/one');

  const downloaded = await continueAttempt(state, port, limits);
  // A whole staged export hands the attempt to the inventory its own rows name, and claims nothing recoverable yet.
  expect([downloaded.stage, downloaded.nextInMs, downloaded.sourcePaused]).toEqual(['inventory', 0, false]);
  expect(calls.parts).toEqual([1, 2]);
  expect(state.state.sqlBytes).toBe(8);
  // The signed download is never left behind, and the staged export is claimed as nothing recoverable.
  expect(state.signed).toBeNull();
  expect(state.state.databaseSha256).toBeNull();
  expect(state.staged).toEqual([]);
  expect(calls.staged).toEqual([]);

  // An attempt admitted with no recorded admission rests at `downloaded` once its export is whole, as it always has.
  const unanchored = checkpoint({ stage: 'download', sqlBytes: 8, sqlEtag: 'w/"one"', uploadId: 'upload-1', downloadOffset: 4, admission: null });
  unanchored.signed = 'https://signed/one';
  unanchored.held = [{ part: 1, bytes: 4, sha256: await digestOf(body(1)), etag: 'etag-1' }];
  const rests = await continueAttempt(unanchored, ports({ ranges: [range(body(2), 8)] }).port, limits);
  expect([rests.stage, rests.nextInMs, unanchored.state.stage]).toEqual(['downloaded', null, 'downloaded']);

  // An attempt an earlier Worker settled at `downloaded` is picked up by no continuation and rewritten by none.
  const settled = checkpoint({ stage: 'downloaded', sqlBytes: 8, downloadOffset: 8 });
  expect(await continueAttempt(settled, ports().port, limits)).toEqual({ attempt: null, stage: 'idle', progressed: false, nextInMs: null, sourcePaused: false });
  expect([settled.state.stage, settled.state.completedAt]).toEqual(['downloaded', null]);
});

it('says the source is paused while an export runs, and asks for an immediate continuation', async () => {
  const state = checkpoint();
  let now = 0;
  const { port } = ports({ exports: [{ status: 'running', bookmark: 'b1' }], now: () => now });
  const report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, maxPollsPerStep: 1 });
  expect([report.stage, report.sourcePaused, report.nextInMs, report.progressed]).toEqual(['export', true, 0, true]);
  expect(state.state.polls).toBe(1);
  now += 1;
});

it('resumes a download from its checkpoint after a reset, keeping the parts it recorded', async () => {
  const state = checkpoint({ stage: 'download', sqlBytes: 8, sqlEtag: 'w/"one"', uploadId: 'upload-1', downloadOffset: 4 });
  state.signed = 'https://signed/one';
  state.held = [{ part: 1, bytes: 4, sha256: await digestOf(body(1)), etag: 'etag-1' }];
  const { port, calls } = ports({ ranges: [range(body(2), 8)] });
  const report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, partBytes: 4 });
  expect(report.stage).toBe('inventory');
  // Only the missing part is read; the recorded one is never fetched a second time.
  expect(calls.parts).toEqual([2]);
  expect(state.state.downloadOffset).toBe(8);
});

it('reconciles a completion interrupted after its commit, and refuses a same-size corruption', async () => {
  const parts = [
    { part: 1, bytes: 4, sha256: await digestOf(body(1)), etag: 'etag-1' },
    { part: 2, bytes: 4, sha256: await digestOf(body(2)), etag: 'etag-2' },
  ];
  const reconciled = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1', downloadOffset: 8 });
  reconciled.held = [...parts];
  const good = ports({
    completeUpload: async () => null,
    storedRange: async (_prefix, offset) => ({ sha256: parts[offset === 0 ? 0 : 1]!.sha256 }),
    storedSize: async () => 8,
  });
  const report = await continueAttempt(reconciled, good.port, PRODUCER_LIMITS);
  expect([report.stage, reconciled.state.reconciled]).toEqual(['inventory', 1]);

  const corrupted = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1', downloadOffset: 8 });
  corrupted.held = [...parts];
  const bad = ports({
    completeUpload: async () => null,
    storedRange: async (_prefix, offset) => ({ sha256: offset === 0 ? parts[0]!.sha256 : await digestOf(body(9)) }),
    storedSize: async () => 8,
  });
  const refusal = await continueAttempt(corrupted, bad.port, PRODUCER_LIMITS);
  expect(refusal.stage).toBe('failed');
  expect(refusal.error).toBe('staging_unreconciled');
});

it('re-exports when the signed download is gone, and refuses one that cannot be read by range', async () => {
  const lost = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1', downloadOffset: 0 });
  lost.signed = 'https://signed/expired';
  const gone = ports({ ranges: [{ status: 'gone' }] });
  const report = await continueAttempt(lost, gone.port, PRODUCER_LIMITS);
  expect([report.stage, lost.state.reExports, lost.state.sqlBytes, gone.calls.aborted]).toEqual(['export', 1, null, 1]);
  expect(lost.signed).toBeNull();

  const unranged = checkpoint({ stage: 'download', sqlBytes: null, uploadId: null });
  unranged.signed = 'https://signed/whole';
  const whole = ports({ ranges: [{ status: 'unranged' }] });
  const refused = await continueAttempt(unranged, whole.port, PRODUCER_LIMITS);
  expect(refused.stage).toBe('failed');
  expect(refused.error).toBe('download_unranged');
});

it('spends bounded transient failures, then fails the attempt', async () => {
  const state = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1' });
  state.signed = 'https://signed/one';
  const limits = { ...PRODUCER_LIMITS, partBytes: 4, maxTransient: 2 };
  const transient: RangeAnswer = { status: 'error', failure: failure('http', 503, true) };
  const { port } = ports({ ranges: [transient, transient, transient] });

  const first = await continueAttempt(state, port, limits);
  expect([first.stage, first.nextInMs, first.error, state.state.attempts]).toEqual(['download', 1_000, 'provider_unavailable', 1]);
  const second = await continueAttempt(state, port, limits);
  expect(second.stage).toBe('failed');
  expect(second.error).toBe('provider_unavailable');
});

it('spends a transient attempt on a request the provider never answered', async () => {
  const state = checkpoint();
  const { port } = ports({ exports: [{ status: 'error', bookmark: null, failure: failure('transport', null, true) }] });
  const report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, maxTransient: 3 });
  expect([report.stage, report.error, state.state.attempts]).toEqual(['export', 'provider_unavailable', 1]);
});

it('names the refusal for each kind of provider failure, and keeps no signed download', async () => {
  for (const [cause, refusal] of [['provider', 'export_failed'], ['http', 'provider_refused'], ['protocol', 'export_not_offered']] as const) {
    const state = checkpoint();
    state.signed = 'https://signed/one';
    const { port } = ports({ exports: [{ status: 'error', bookmark: 'b1', failure: failure(cause, 403, false) }] });
    const report = await continueAttempt(state, port, PRODUCER_LIMITS);
    expect([cause, report.stage, report.nextInMs, state.state.error, state.signed]).toEqual([cause, 'failed', null, refusal, null]);
  }
});

it('refuses an export whose bytes changed between ranged reads', async () => {
  const state = checkpoint({ stage: 'download', sqlBytes: 8, sqlEtag: 'w/"one"', uploadId: 'upload-1', downloadOffset: 4 });
  state.signed = 'https://signed/one';
  state.held = [{ part: 1, bytes: 4, sha256: await digestOf(body(1)), etag: 'etag-1' }];
  const { port } = ports({ ranges: [range(body(2), 12, 'w/"two"')] });
  const report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, partBytes: 4 });
  expect(report.stage).toBe('failed');
  expect(report.error).toBe('download_changed');
});

it('retries a provider outage during an export rather than ending the attempt, then fails within its bound', async () => {
  const state = checkpoint();
  const outage: ExportAnswer = { status: 'error', bookmark: 'b1', failure: failure('http', 503, true) };
  const { port } = ports({ exports: [outage, outage] });
  const limits = { ...PRODUCER_LIMITS, maxTransient: 2 };
  const first = await continueAttempt(state, port, limits);
  expect([first.stage, first.error, state.state.attempts]).toEqual(['export', 'provider_unavailable', 1]);
  const second = await continueAttempt(state, port, limits);
  expect([second.stage, second.error]).toEqual(['failed', 'provider_unavailable']);
});

it('bounds how many times one attempt may ask for a fresh export', async () => {
  const limits = { ...PRODUCER_LIMITS, partBytes: 4, maxReExports: 2 };
  const state = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1', reExports: 2 });
  state.signed = 'https://signed/expired';
  const { port } = ports({ ranges: [{ status: 'gone' }] });
  const report = await continueAttempt(state, port, limits);
  expect([report.stage, report.error, state.state.reExports]).toEqual(['failed', 'download_lost', 2]);
});

it('carries neither provider text nor an exception message into a status or a log', async () => {
  const marker = 'private-marker-not-a-real-credential';
  const logged: string[] = [];
  const original = console.log;
  console.log = (line: string) => { logged.push(String(line)); };
  try {
    const state = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1' });
    state.signed = `https://signed/one?token=${marker}`;
    const { port } = ports({ ranges: [{ status: 'error', failure: failure('http', 403, false) }] });
    const refused = await continueAttempt(state, port, PRODUCER_LIMITS);
    expect([refused.stage, refused.error]).toEqual(['failed', 'download_changed']);

    // An exception a port throws is classified, never quoted: one bounded attempt, then a terminal refusal.
    const thrown = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1', attempts: 1 });
    thrown.signed = 'https://signed/two';
    const { port: throwing } = ports();
    throwing.readRange = async () => { throw new Error(`the provider said ${marker}`); };
    const interrupted = await continueAttempt(thrown, throwing, { ...PRODUCER_LIMITS, maxTransient: 3 });
    expect([interrupted.stage, interrupted.error, thrown.state.attempts]).toEqual(['download', undefined, 2]);
    const internal = await continueAttempt(thrown, throwing, { ...PRODUCER_LIMITS, maxTransient: 3 });
    expect([internal.stage, internal.error]).toEqual(['failed', 'internal']);
    expect(JSON.stringify([refused, interrupted, internal, thrown.state, state.state])).not.toContain(marker);
  } finally { console.log = original; }
  expect(logged.length).toBeGreaterThan(0);
  expect(logged.join('\n')).not.toContain(marker);
  // Every value a log carries is a number, a boolean, or one of the fixed names the producer may report.
  const fixed = new Set([
    'recovery_attempt_failed', 'recovery_attempt_transient', 'recovery_attempt_interrupted',
    'recovery_inventory_read', 'recovery_staging_completed',
    'export', 'download', 'inventory', 'copy', 'downloaded', 'complete', 'failed',
    'provider_unavailable', 'provider_refused', 'export_failed', 'export_not_offered', 'export_unparsable',
    'download_unranged', 'download_changed', 'download_lost', 'staging_unreconciled', 'schema_disagrees', 'internal',
    'export_stalled', 'staging_changed', 'inventory_disagrees', 'inventory_unreadable', 'inventory_oversize',
    'object_missing', 'object_changed', 'staging_incomplete',
    'transport', 'http', 'provider', 'protocol', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'other',
  ]);
  for (const line of logged) {
    for (const [key, value] of Object.entries(JSON.parse(line) as Record<string, unknown>)) {
      const allowed = typeof value === 'number' || typeof value === 'boolean' || (typeof value === 'string' && fixed.has(value));
      expect({ key, value, allowed }).toEqual({ key, value, allowed: true });
    }
  }
});

it('resumes after a staging store failure worth another attempt, and fails once the bound is spent', async () => {
  const held = [{ part: 1, bytes: 4, sha256: await digestOf(body(1)), etag: 'etag-1' }];
  const overload = () => new TransientProducerFailure({ cause: 'storage', status: null, transient: true });

  // One overloaded write, then the store takes it: the attempt keeps its recorded part and reaches a staged export.
  const state = checkpoint({ stage: 'download', sqlBytes: 8, sqlEtag: 'w/"one"', uploadId: 'upload-1', downloadOffset: 4 });
  state.signed = 'https://signed/one';
  state.held = [...held];
  const { port } = ports({ ranges: [range(body(2), 8), range(body(2), 8)] });
  let refusals = 1;
  const flaky: ProducerPorts = {
    ...port,
    async writePart(prefix, uploadId, part, bytes, length) {
      if (refusals-- > 0) throw overload();
      return port.writePart(prefix, uploadId, part, bytes, length);
    },
  };
  const spent = await continueAttempt(state, flaky, { ...PRODUCER_LIMITS, partBytes: 4, maxTransient: 3 });
  expect([spent.stage, spent.error, spent.nextInMs, state.state.attempts]).toEqual(['download', 'provider_unavailable', 1_000, 1]);
  expect(state.held.map((part) => part.part)).toEqual([1]);
  const resumed = await continueAttempt(state, flaky, { ...PRODUCER_LIMITS, partBytes: 4, maxTransient: 3 });
  expect([resumed.stage, state.state.downloadOffset, state.held.length]).toEqual(['inventory', 8, 2]);

  // A store that stays overloaded ends the attempt at its bound, with a reason from the closed set.
  const exhausted = checkpoint({ stage: 'download', sqlBytes: 8, sqlEtag: 'w/"one"', uploadId: 'upload-1', downloadOffset: 4, attempts: 1 });
  exhausted.signed = 'https://signed/one';
  exhausted.held = [...held];
  const { port: base } = ports({ ranges: [range(body(2), 8)] });
  const refusing: ProducerPorts = { ...base, async writePart() { throw overload(); } };
  const ended = await continueAttempt(exhausted, refusing, { ...PRODUCER_LIMITS, partBytes: 4, maxTransient: 2 });
  expect([ended.stage, ended.error, exhausted.state.error]).toEqual(['failed', 'provider_unavailable', 'provider_unavailable']);
});

it('ends an export nothing completes, and stops holding the source back', async () => {
  const state = checkpoint();
  let clock = 0;
  let polls = 0;
  const running: ProducerPorts = {
    now: () => clock,
    async pollExport() { polls += 1; clock += 50; return { status: 'running', bookmark: 'b1' }; },
    async readRange() { throw new Error('the export never completed'); },
    async beginUpload() { return 'u'; },
    async writePart() { return { sha256: '', etag: '' }; },
    async completeUpload() { return null; },
    async abortUpload() {},
    async readStoredRange() { return null; },
    async storedSize() { return null; },
    async writeStagingFile() {},
    async readStagedPart() { throw new Error('this stage reads no staged part'); },
    async digest() { throw new Error('this stage takes no digest'); },
    async copyObject() { throw new Error('this stage copies no object'); },
    async readStagingFile() { return null; },
  };
  const limits = { ...PRODUCER_LIMITS, exportPollMs: 60_000 };
  let last = await continueAttempt(state, running, limits);
  let steps = 1;
  while (last.stage === 'export' && clock < 10 * 60_000) {
    clock += 2_000;
    last = await continueAttempt(state, running, limits);
    steps += 1;
  }
  // The attempt ends inside its own budget, says why from the closed set, and no longer reports the source paused.
  expect([last.stage, last.error, last.sourcePaused, last.nextInMs]).toEqual(['failed', 'export_stalled', false, null]);
  expect(state.state.exportStartedAt).toBe(0);
  expect(clock).toBeLessThanOrEqual(limits.exportPollMs + 2_000 + limits.stepMs);
  // Each continuation polls a bounded number of times, so a stalled export is not a million provider calls.
  expect(polls).toBeLessThanOrEqual(steps * limits.maxPollsPerStep);
});

it('starts the export again when the provider refuses a bookmark it holds, and ends when that bound is spent', async () => {
  const inner = (): ExportAnswer => ({ status: 'error', bookmark: 'b1', failure: failure('provider', 200, false) });
  // A refusal of a bookmark this attempt holds: the export restarts, within the same bound as a lost download.
  const state = checkpoint({ stage: 'export', bookmark: 'b1', polls: 4, exportStartedAt: 0 });
  state.signed = 'https://signed/one';
  const { port } = ports({ exports: [inner()] });
  const restarted = await continueAttempt(state, port, PRODUCER_LIMITS);
  expect([restarted.stage, restarted.sourcePaused, restarted.nextInMs]).toEqual(['export', false, 0]);
  // The origin stands through a restart: the budget belongs to the attempt, not to each export it asks for.
  expect([state.state.bookmark, state.state.reExports, state.state.exportStartedAt]).toEqual([null, 1, 0]);
  expect(state.signed).toBeNull();

  // A refusal of a fresh request ends the attempt: there is no earlier export to return to.
  const fresh = checkpoint({ stage: 'export', bookmark: null });
  const { port: refusing } = ports({ exports: [{ status: 'error', bookmark: null, failure: failure('provider', 200, false) }] });
  const ended = await continueAttempt(fresh, refusing, PRODUCER_LIMITS);
  expect([ended.stage, ended.error]).toEqual(['failed', 'export_failed']);

  // And once the re-export bound is spent, a refusal ends the attempt rather than restarting again.
  const spent = checkpoint({ stage: 'export', bookmark: 'b9', reExports: 3 });
  const { port: last } = ports({ exports: [inner()] });
  const exhausted = await continueAttempt(spent, last, { ...PRODUCER_LIMITS, maxReExports: 3 });
  expect([exhausted.stage, exhausted.error]).toEqual(['failed', 'export_failed']);
});

it('announces a terminal refusal only after it is durable, and keeps it when clearing up fails', async () => {
  const logged: string[] = [];
  const original = console.log;
  const state = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1' });
  state.signed = 'https://signed/one';
  const { port } = ports({ ranges: [{ status: 'unranged' }] });
  const refusingCleanup: ProducerPorts = { ...port, async abortUpload() { throw new Error('the store refused the abort'); } };
  console.log = (line: string) => {
    // Whenever the refusal is announced, the checkpoint already holds it.
    logged.push(String(line));
    expect([state.state.stage, state.state.error]).toEqual(['failed', 'download_unranged']);
  };
  try {
    const report = await continueAttempt(state, refusingCleanup, PRODUCER_LIMITS);
    expect([report.stage, report.error]).toEqual(['failed', 'download_unranged']);
  } finally { console.log = original; }
  expect(logged.some((line) => line.includes('recovery_attempt_failed') && line.includes('download_unranged'))).toBe(true);
});

it('keeps one export budget across restarts, and spends it once', async () => {
  const state = checkpoint({ stage: 'export', bookmark: 'b1', exportStartedAt: 0, polls: 1 });
  let clock = 95;
  const refusal: ExportAnswer = { status: 'error', bookmark: 'b1', failure: failure('provider', 200, false) };
  const running: ExportAnswer = { status: 'running', bookmark: 'b2' };
  const { port } = ports({ exports: [refusal, running], now: () => clock });
  const limits = { ...PRODUCER_LIMITS, exportPollMs: 100, maxPollsPerStep: 1 };

  const restarted = await continueAttempt(state, port, limits);
  expect([restarted.stage, state.state.exportStartedAt, state.state.reExports]).toEqual(['export', 0, 1]);

  clock = 101;
  const ended = await continueAttempt(state, port, limits);
  expect([ended.stage, ended.error, ended.sourcePaused]).toEqual(['failed', 'export_stalled', false]);
});

it('takes a completion a poll inside the budget answered, and ends one that is still running past it', async () => {
  const late = checkpoint({ stage: 'export', bookmark: 'held', exportStartedAt: 0 });
  let clock = 99;
  const { port: completing } = ports({
    exports: [{ status: 'complete', bookmark: 'held', signedUrl: 'https://signed/one' }],
    now: () => clock,
  });
  completing.pollExport = async () => { clock = 101; return { status: 'complete', bookmark: 'held', signedUrl: 'https://signed/one' }; };
  const taken = await continueAttempt(late, completing, { ...PRODUCER_LIMITS, exportPollMs: 100 });
  // A poll issued inside the budget has its answer taken: the export is done and the source is free.
  expect([taken.stage, taken.sourcePaused]).toEqual(['download', false]);

  const stalled = checkpoint({ stage: 'export', bookmark: 'held', exportStartedAt: 0 });
  let moving = 99;
  const { port: still } = ports({ now: () => moving });
  still.pollExport = async () => { moving = 101; return { status: 'running', bookmark: 'held' }; };
  const over = await continueAttempt(stalled, still, { ...PRODUCER_LIMITS, exportPollMs: 100 });
  expect([over.stage, over.error, over.sourcePaused]).toEqual(['failed', 'export_stalled', false]);
});

it('clears what it can when an attempt ends, and says which clearing up failed', async () => {
  const logged: Record<string, unknown>[] = [];
  const original = console.log;
  const state = checkpoint({ stage: 'download', sqlBytes: 8, uploadId: 'upload-1' });
  state.signed = 'https://signed/one';
  const { port } = ports({ ranges: [{ status: 'unranged' }] });
  const refusingAbort: ProducerPorts = { ...port, async abortUpload() { throw new Error('the store refused the abort'); } };
  console.log = (line: string) => { logged.push(JSON.parse(String(line)) as Record<string, unknown>); };
  try {
    const report = await continueAttempt(state, refusingAbort, PRODUCER_LIMITS);
    expect([report.stage, report.error]).toEqual(['failed', 'download_unranged']);
  } finally { console.log = original; }
  // The refusal stands, the signed download is gone even though the abort failed, and both outcomes are reported.
  expect([state.state.stage, state.state.error, state.signed]).toEqual(['failed', 'download_unranged', null]);
  const failure = logged.find((event) => event.kind === 'recovery_attempt_failed')!;
  expect([failure.refusal, failure.uploadAborted, failure.signedUrlCleared]).toEqual(['download_unranged', false, true]);
});
