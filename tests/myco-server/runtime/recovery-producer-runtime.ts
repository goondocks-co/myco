/**
 * Runtime proof for the hosted recovery producer, on real workerd.
 *
 * `wrangler dev --local` runs the product's own `RecoveryProducer` Durable Object with local R2 and a loopback
 * stand-in for the provider's export API, in a throwaway state directory. What it proves cannot be proven in
 * process: SQLite storage that survives a restart mid-attempt, a continuation that advances while the source is
 * paused, overlapping wakes serialized by the object itself, and an attempt that stays terminal.
 *
 * Every process it starts is stopped by its exact PID. Usage: bun tests/myco-server/runtime/recovery-producer-runtime.ts
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '../../..');
const WRANGLER = path.join(ROOT, 'node_modules/.bin/wrangler');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-producer-runtime-'));
const EVIDENCE = process.env.MYCO_PRODUCER_EVIDENCE ?? path.join(RUN, 'result.json');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const port = (s.address() as net.AddressInfo).port; s.close(() => resolve(port)); }); });
const digestOf = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join('');
};
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);

async function stop(proc: ReturnType<typeof Bun.spawn>, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const tree = descendants(proc.pid);
  for (const pid of [proc.pid, ...tree]) { try { process.kill(pid, signal); } catch {} }
  await proc.exited;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (tree.every((pid) => { try { process.kill(pid, 0); return false; } catch { return true; } })) return;
    await Bun.sleep(100);
  }
  for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch {} }
}

/** The objects this export's own rows name, and the bytes the Deployment's store holds for them. */
const BLOB_BODY = new Uint8Array([0, 1, 127, 128, 255]);
const BACKUP_BODY = new TextEncoder().encode('{"format":"myco-backup/1"}\n');
// A blob is content-addressed: its key is the digest of its own bytes, which the staged copy is held to.
const BLOB_DIGEST = new Bun.CryptoHasher('sha256').update(BLOB_BODY).digest('hex');
const BACKUP_KEY = 'backups/lineage__1__bk_runtime.jsonl';
const SOURCE_OBJECTS: Record<string, Uint8Array> = { [`proj_1/${BLOB_DIGEST}`]: BLOB_BODY, [BACKUP_KEY]: BACKUP_BODY };

const BLOBS_DDL = 'CREATE TABLE blobs (project_id TEXT NOT NULL, key TEXT NOT NULL, size INTEGER NOT NULL, PRIMARY KEY (project_id, key))';
const BACKUPS_DDL = 'CREATE TABLE backups (id TEXT PRIMARY KEY, key TEXT NOT NULL, created_at INTEGER NOT NULL, size_bytes INTEGER NOT NULL, counts_json TEXT NOT NULL, schema_version INTEGER NOT NULL, producer TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, sha256 TEXT)';

/**
 * The export's bytes: definitions the capture must agree with, the rows naming this Deployment's own objects — one
 * of them a catalogued backup whose row records no digest — padded past the provider's part floor so a real
 * multipart completion is exercised rather than a single-part shortcut.
 */
const HEAD = new TextEncoder().encode([
  'CREATE TABLE sessions (id TEXT);',
  `${BLOBS_DDL};`,
  `${BACKUPS_DDL};`,
  `INSERT INTO blobs VALUES('proj_1','${BLOB_DIGEST}',${BLOB_BODY.byteLength});`,
  `INSERT INTO backups VALUES('bk_1','${BACKUP_KEY}',1789590000000,${BACKUP_BODY.byteLength},'{}',41,'myco',0,NULL);`,
  '',
].join('\n'));
const EXPORT = new Uint8Array(6 * 1024 * 1024 + 1024);
EXPORT.set(HEAD, 0);
EXPORT.fill(0x20, HEAD.byteLength);

/** A loopback stand-in for the provider: an export that runs for a set number of polls, then a signed download. */
function stubProvider(port: number, pollsBeforeComplete: number, options: { completeAfterMs?: number; pollDelayMs?: number; refuseInner?: boolean } = {}) {
  const state = {
    polls: 0, ranges: 0, tokens: [] as string[], signedAuth: [] as Array<string | null>, gone: false,
    /** Every bookmark a poll carried, in order; a fresh export carries none. */
    bookmarks: [] as Array<string | null>, starts: 0, firstPollAt: 0, completedAt: 0, refusing: false,
  };
  const server = Bun.serve({
    port, hostname: '127.0.0.1',
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname.endsWith('/export')) {
        state.polls += 1;
        if (state.firstPollAt === 0) state.firstPollAt = Date.now();
        const held = request.headers.get('authorization') ?? 'none';
        if (!state.tokens.includes(held)) state.tokens.push(held);
        const asked = await request.json().catch(() => ({})) as { current_bookmark?: string };
        const carried = asked.current_bookmark ?? null;
        state.bookmarks.push(carried);
        if (carried === null) state.starts += 1;
        if (options.pollDelayMs !== undefined) await Bun.sleep(options.pollDelayMs);
        // HTTP 200 with an outer success and an inner refusal.
        if (options.refuseInner === true || state.refusing) {
          return Response.json({ success: true, result: { success: false, error: 'provider-controlled text' } });
        }
        const waiting = options.completeAfterMs !== undefined && Date.now() - state.firstPollAt < options.completeAfterMs;
        if (waiting || state.polls < pollsBeforeComplete) return Response.json({ success: true, result: { status: 'active', at_bookmark: `b${state.polls}` } });
        if (state.completedAt === 0) state.completedAt = Date.now();
        return Response.json({
          success: true,
          result: { status: 'complete', at_bookmark: 'b-final', result: { signed_url: `http://127.0.0.1:${port}/signed/export.sql` } },
        });
      }
      if (url.pathname === '/signed/export.sql') {
        state.ranges += 1;
        state.signedAuth.push(request.headers.get('authorization'));
        if (state.gone) return new Response('gone', { status: 403 });
        const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get('range') ?? '');
        if (range === null) return new Response(EXPORT, { status: 200 });
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), EXPORT.byteLength - 1);
        return new Response(EXPORT.slice(start, end + 1), {
          status: 206,
          headers: { 'content-range': `bytes ${start}-${end}/${EXPORT.byteLength}`, etag: 'w/"export"' },
        });
      }
      if (url.pathname === '/state') return Response.json(state, { headers: { 'content-type': 'application/json' } });
      if (url.pathname === '/gone') { state.gone = true; return Response.json({ gone: true }); }
      if (url.pathname === '/refuse') { state.refusing = true; return Response.json({ refusing: true }); }
      return new Response('not found', { status: 404 });
    },
  });
  return {
    server,
    state: () => fetch(`http://127.0.0.1:${port}/state`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json() as Promise<typeof state & { tokens: string[] }>),
    refuse: () => fetch(`http://127.0.0.1:${port}/refuse`, { signal: AbortSignal.timeout(30_000) }).then((r) => r.json()),
  };
}

/**
 * The producer as it shipped before this slice, extracted from its own commit, so an upgrade is proven against the
 * storage that version really writes rather than a hand-made imitation of it. Its bare imports resolve through the
 * worktree's installed packages.
 */
const PREVIOUS_COMMIT = 'b27bf94d';
function previousSource(): string {
  const root = path.join(RUN, 'previous');
  fs.mkdirSync(root, { recursive: true });
  // The server's own tsconfig and the shared package's source come too, so its aliases resolve as the current tree's do.
  const archive = Bun.spawnSync(['git', '-C', ROOT, 'archive', PREVIOUS_COMMIT,
    'packages/myco-server/src', 'packages/myco-server/tsconfig.json', 'packages/myco-shared/src'], { stdin: 'ignore' });
  if (archive.exitCode !== 0) throw new Error(`git archive ${PREVIOUS_COMMIT} failed`);
  const unpack = Bun.spawnSync(['tar', '-x', '-C', root], { stdin: archive.stdout });
  if (unpack.exitCode !== 0) throw new Error('unpacking the previous producer failed');
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(root, 'node_modules'));
  return path.join(root, 'packages/myco-server/src');
}

/** A test entry that re-exports the product's own Durable Object and calls it, so workerd runs the shipped class. */
const ENTRY = `
import { RecoveryProducer } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/recovery-producer-object.ts')}';
import { DeploymentClock } from '${path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/deployment-clock.ts')}';
import { capturedDefinitions } from '${path.join(ROOT, 'packages/myco-server/src/core/recovery-producer.ts')}';
export { RecoveryProducer, DeploymentClock };

const SCHEMA = [
  { type: 'table', name: 'sessions', sql: 'CREATE TABLE sessions (id TEXT)', storage: 'table' },
  { type: 'table', name: 'blobs', sql: ${'`'}${BLOBS_DDL}${'`'}, storage: 'table' },
  { type: 'table', name: 'backups', sql: ${'`'}${BACKUPS_DDL}${'`'}, storage: 'table' },
];
const admission = () => ({
  tables: ['sessions', 'blobs', 'backups'],
  schema: JSON.stringify(SCHEMA),
  captured: capturedDefinitions(SCHEMA),
  configuration: { startedBy: 'runtime-test' },
  credentialsRequired: [],
});
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const producer = env.RECOVERY.get(env.RECOVERY.idFromName('recovery'));
    if (url.pathname === '/admit') return Response.json(await producer.admit(admission()));
    if (url.pathname === '/admit-and-continue') {
      const limits = JSON.parse(url.searchParams.get('limits') ?? '{}');
      const [admitted, continued] = await Promise.all([producer.admit(admission()), producer.continue(limits)]);
      return Response.json({ admitted, continued });
    }
    if (url.pathname === '/continue') return Response.json(await producer.continue(JSON.parse(url.searchParams.get('limits') ?? '{}')));
    if (url.pathname === '/continue-twice') {
      const limits = JSON.parse(url.searchParams.get('limits') ?? '{}');
      const [first, second] = await Promise.all([producer.continue(limits), producer.continue(limits)]);
      return Response.json({ first, second });
    }
    if (url.pathname === '/status') return Response.json(await producer.status());
    if (url.pathname === '/wake') {
      const clock = env.CLOCK.get(env.CLOCK.idFromName('deployment'));
      try { return Response.json({ woke: await clock.wake() }); } catch (error) { return Response.json({ raised: String(error).slice(0, 160) }); }
    }
    if (url.pathname === '/ensure') {
      await env.CLOCK.get(env.CLOCK.idFromName('deployment')).ensure();
      return Response.json({ ensured: true });
    }
    if (url.pathname === '/drift') return Response.json(await producer.noteSchemaDrift(Number(url.searchParams.get('attempt'))));
    if (url.pathname === '/staged') {
      const key = await producer.stagedKey(Number(url.searchParams.get('attempt')));
      const object = key === null ? null : await env.RECOVERY_BUCKET.get(key);
      if (object === null) return Response.json({ staged: null });
      const bytes = new Uint8Array(await object.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Response.json({
        bytes: bytes.byteLength, key,
        sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      });
    }
    if (url.pathname === '/seed-object') {
      const key = url.searchParams.get('key');
      await env.BUCKET.put(key, request.body);
      return Response.json({ seeded: key });
    }
    if (url.pathname === '/staged-object') {
      const object = await env.RECOVERY_BUCKET.get(url.searchParams.get('key'));
      if (object === null) return Response.json({ object: null });
      const bytes = new Uint8Array(await object.arrayBuffer());
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Response.json({
        bytes: bytes.byteLength,
        sha256: [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, '0')).join(''),
      });
    }
    if (url.pathname === '/staging-file') {
      const object = await env.RECOVERY_BUCKET.get(url.searchParams.get('key'));
      return object === null ? Response.json({ file: null }) : Response.json({ file: JSON.parse(await object.text()) });
    }
    return new Response('not found', { status: 404 });
  },
};
`;

let worker: ReturnType<typeof Bun.spawn> | null = null;
let workerPort = 0;
async function startWorker(apiPort: number, mode: 'manual' | 'clock' = 'manual', state = 'state', entry = ENTRY): Promise<void> {
  const clockLines = mode === 'clock'
    ? [
      '[[durable_objects.bindings]]', 'name = "CLOCK"', 'class_name = "DeploymentClock"', '',
      '[[d1_databases]]', 'binding = "MYCO_DB"', 'database_name = "myco-producer-runtime"',
      'database_id = "00000000-0000-4000-8000-000000001316"', '',
      '[[migrations]]', 'tag = "v2-clock"', 'new_sqlite_classes = [ "DeploymentClock" ]', '',
    ]
    : [];
  const config = [
    'name = "myco-producer-runtime"',
    'main = "entry.ts"',
    'compatibility_date = "2026-08-01"',
    '',
    '[[durable_objects.bindings]]',
    'name = "RECOVERY"',
    'class_name = "RecoveryProducer"',
    '',
    ...clockLines,
    '[[migrations]]',
    'tag = "v4-recovery"',
    'new_sqlite_classes = [ "RecoveryProducer" ]',
    '',
    '[[r2_buckets]]',
    'binding = "RECOVERY_BUCKET"',
    'bucket_name = "myco-producer-runtime-recovery"',
    '',
    '[[r2_buckets]]',
    'binding = "BUCKET"',
    'bucket_name = "myco-producer-runtime-blobs"',
    '',
    '[vars]',
    'MYCO_RECOVERY_ACCOUNT_ID = "runtime-account"',
    'MYCO_RECOVERY_DATABASE_ID = "runtime-database"',
    `MYCO_RECOVERY_API_ORIGIN = "http://127.0.0.1:${apiPort}"`,
    ...(mode === 'manual' ? ['CLOCK_MODE = "manual"'] : []),
    'HARNESS_LAUNCH_MODE = "record"',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(RUN, 'wrangler.toml'), config);
  fs.writeFileSync(path.join(RUN, 'entry.ts'), entry);
  fs.writeFileSync(path.join(RUN, '.dev.vars'), 'RECOVERY_EXPORT_TOKEN=runtime-token-not-a-credential\n');
  workerPort = await freePort();
  const inspector = await freePort();
  const logFile = path.join(RUN, 'wrangler.log');
  const logStart = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  const log = fs.openSync(logFile, 'a');
  worker = Bun.spawn([WRANGLER, 'dev', '--local', '--ip', '127.0.0.1', '--port', String(workerPort), '--inspector-port', String(inspector), '--persist-to', path.join(RUN, state), '-c', path.join(RUN, 'wrangler.toml')], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', NO_COLOR: '1' },
  });
  owned.push({ what: 'wrangler dev', pid: worker.pid });
  // Readiness is bounded three ways: every probe carries its own deadline, a runtime that exits or reports a failed
  // build ends the wait at once with its own words, and the whole wait has a ceiling.
  const since = (): string => {
    const text = fs.readFileSync(logFile, 'utf8');
    return text.slice(logStart);
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${workerPort}/status`, { signal: AbortSignal.timeout(2_000) })).ok) return;
    } catch {}
    const written = since();
    if (worker.exitCode !== null || /Build failed|\[ERROR\]/.test(written)) {
      throw new Error(`wrangler dev did not start (exit ${worker.exitCode ?? 'none'}):\n${written.replace(/\x1b\[[0-9;]*m/g, '').slice(-1_500)}`);
    }
    await Bun.sleep(250);
  }
  throw new Error(`wrangler dev did not answer within 90s:\n${since().replace(/\x1b\[[0-9;]*m/g, '').slice(-1_500)}`);
}
const routes: string[] = [];
/** Every call to the runtime carries a deadline, so a runtime that stops answering fails the run instead of holding it. */
const call = async (route: string): Promise<any> => {
  routes.push(route.split('?')[0]!);
  return (await fetch(`http://127.0.0.1:${workerPort}${route}`, { signal: AbortSignal.timeout(180_000) })).json();
};
const STEP = '{"exportPollMs":600000,"maxPollsPerStep":1,"stepMs":20000,"partBytes":5242880,"maxTransient":5,"maxReExports":3}';

let failure: unknown = null;
const apiPort = await freePort();
const provider = stubProvider(apiPort, 3);
try {
  await startWorker(apiPort);
  const seed = async (): Promise<void> => {
    for (const [key, body] of Object.entries(SOURCE_OBJECTS)) {
      routes.push('/seed-object');
      await fetch(`http://127.0.0.1:${workerPort}/seed-object?key=${encodeURIComponent(key)}`, { method: 'PUT', body: body.buffer as ArrayBuffer, signal: AbortSignal.timeout(30_000) });
    }
  };
  await seed();
  check('nothing is open before an attempt is admitted', (await call('/continue')).stage, 'idle');
  const admitted = await call('/admit');
  check('an admitted attempt stages its schema and claims nothing recoverable', [admitted.stage, admitted.recoverable, admitted.stagedSchema !== null], ['export', false, true]);
  const manifest = await call(`/staging-file?key=${encodeURIComponent(`${admitted.staged.prefix}/recovery.json`)}`);
  check('the staging it writes is open, with no object and no completion', [manifest.file.status, manifest.file.objects.length, manifest.file.completedAt], ['open', 0, undefined]);

  // One continuation that cannot finish the export: the source is paused and another continuation is wanted at once.
  const paused = await call(`/continue?limits=${encodeURIComponent(STEP)}`);
  check('while the export runs the source is paused and the next continuation is immediate', [paused.stage, paused.sourcePaused, paused.nextInMs], ['export', true, 0]);

  // A restart mid-attempt: the Durable Object's own storage is what the next continuation resumes from.
  const before = await call('/status');
  await stop(worker!, 'SIGKILL');
  worker = null;
  await startWorker(apiPort);
  const after = await call('/status');
  check('a restart mid-export keeps the attempt and its polls', [after.attempt, after.stage, after.export.polls === before.export.polls], [before.attempt, 'export', true]);

  const completed = await call('/continue?limits={"exportPollMs":600000,"maxPollsPerStep":12,"stepMs":60000,"partBytes":5242880,"maxTransient":5,"maxReExports":3}');
  check('the export completes after the restart and the download begins', [completed.stage, completed.sourcePaused], ['download', false]);
  const wide = '{"exportPollMs":600000,"maxPollsPerStep":12,"stepMs":60000,"partBytes":5242880,"maxTransient":5,"maxReExports":3,"maxPartsPerStep":1,"maxObjectsPerStep":1,"inventoryMs":600000,"copyMs":600000}';
  const downloaded = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  note('download outcome', downloaded);
  check('a staged export hands the attempt to the inventory its own rows name', [downloaded.stage, downloaded.nextInMs, downloaded.error ?? null], ['inventory', 0, null]);

  // The staging stages, driven one continuation at a time as the clock drives them.
  let staging = downloaded;
  for (let step = 0; step < 64 && staging.nextInMs !== null; step += 1) {
    staging = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  }
  note('staging outcome', staging);
  check('the inventory, the copies and the completion carry the attempt to a complete staging', [staging.stage, staging.nextInMs, staging.error ?? null], ['complete', null, null]);

  const published = await call(`/staging-file?key=${encodeURIComponent(`${admitted.staged.prefix}/recovery.json`)}`);
  check('the completed staging names the export it verified and every object its rows register', [
    published.file.status, published.file.database.bytes, published.file.database.sha256,
    published.file.objects.map((object: { key: string }) => object.key).sort(),
    typeof published.file.completedAt, published.file.exportBookmark !== undefined,
  ], ['complete', EXPORT.byteLength, await digestOf(EXPORT), Object.keys(SOURCE_OBJECTS).sort(), 'string', true]);

  for (const [key, body] of Object.entries(SOURCE_OBJECTS)) {
    const staged = await call(`/staged-object?key=${encodeURIComponent(`${admitted.staged.prefix}/objects/${key}`)}`);
    const listed = published.file.objects.find((object: { key: string }) => object.key === key);
    check(`the staged copy of ${key} is the Deployment's own bytes, under the digest the manifest lists`,
      [staged.bytes, staged.sha256, listed.bytes, listed.sha256],
      [body.byteLength, await digestOf(body), body.byteLength, await digestOf(body)]);
  }
  const staged = await call(`/staged?attempt=${admitted.attempt}`);
  check('the staged export is the provider\'s own bytes', [staged.bytes, staged.sha256], [EXPORT.byteLength, await digestOf(EXPORT)]);
  const status = await call('/status');
  check('both parts were recorded and nothing claims recoverability', [status.staged.parts, status.staged.downloadedBytes, status.recoverable], [2, EXPORT.byteLength, false]);

  const seen = await provider.state();
  note('provider calls', seen);
  check('the credential reached the provider and never the signed download', [seen.tokens, seen.signedAuth.filter((held: string | null) => held !== null)], [['Bearer runtime-token-not-a-credential'], []]);

  check('a terminal attempt needs no further continuation', (await call('/continue')).stage, 'idle');
  // A completed staging is a snapshot whole as taken: a later schema change leaves it complete.
  const kept = await call(`/drift?attempt=${admitted.attempt}`);
  check('a schema that moved after a staging completed leaves that staging complete', [kept.stage, kept.error], ['complete', null]);

  // Overlapping wakes: the object shares the one step in flight, so two of them ask the provider once.
  const second = await call('/admit');
  const beforeOverlap = (await provider.state()).polls;
  const both = await call(`/continue-twice?limits=${encodeURIComponent(STEP)}`);
  note('overlapping continuations', both);
  const afterOverlap = (await provider.state()).polls;
  check('two overlapping continuations start one export, not two', afterOverlap - beforeOverlap, 1);
  check('both callers are answered the same step', [both.first.attempt, both.second.attempt, JSON.stringify(both.first) === JSON.stringify(both.second)], [second.attempt, second.attempt, true]);
  const afterBoth = await call('/status');
  check('the shared step advanced the attempt once, staging nothing twice',
    [afterBoth.attempt, ['export', 'download'].includes(afterBoth.stage), afterBoth.staged.parts], [second.attempt, true, 0]);

  // An admission that overlaps a continuation: the continuation either finds nothing or finds an attempt already
  // staged whole, never one whose schema and manifest are still being written.
  const overlapped = await call(`/admit-and-continue?limits=${encodeURIComponent(STEP)}`);
  note('admission overlapping a continuation', overlapped);
  check('an overlapping admission never leaves a half-prepared attempt', [
    overlapped.admitted.attempt === second.attempt,
    overlapped.continued.attempt === null || overlapped.continued.attempt === second.attempt,
    overlapped.admitted.stagedSchema !== null,
  ], [true, true, true]);
  const prepared = await call(`/staging-file?key=${encodeURIComponent(`${overlapped.admitted.staged.prefix}/schema.json`)}`);
  check('the attempt an admission published carries its captured schema', Array.isArray(prepared.file), true);
  // An attempt with nothing published is still failed by a schema that moved after its capture.
  const drifted = await call(`/drift?attempt=${second.attempt}`);
  check('a schema that moved after the capture fails an attempt that has published nothing', [drifted.stage, drifted.error], ['failed', 'schema_disagrees']);

  // An upgrade: the producer this slice replaces settles an attempt at `downloaded` in its own storage, and the new
  // Worker then boots on that very storage. The settled attempt is kept exactly, never advanced, and its open manifest
  // is never rewritten; the attempts table gains its columns in place, twice over; and a new admission still runs.
  await stop(worker!, 'SIGTERM');
  worker = null;
  const previous = previousSource();
  const previousEntry = ENTRY.replaceAll(path.join(ROOT, 'packages/myco-server/src'), previous);
  await startWorker(apiPort, 'manual', 'upgrade-state', previousEntry);
  await seed();
  const settledAdmission = await call('/admit');
  let settled = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  for (let step = 0; step < 16 && settled.nextInMs !== null; step += 1) settled = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  check('the previous producer settles its attempt at a staged export', settled.stage, 'downloaded');
  const settledKey = `${settledAdmission.staged.prefix}/recovery.json`;
  const settledManifest = await call(`/staging-file?key=${encodeURIComponent(settledKey)}`);
  const settledStatus = await call('/status');
  await stop(worker!, 'SIGTERM');
  worker = null;

  for (const boot of [1, 2]) {
    await startWorker(apiPort, 'manual', 'upgrade-state');
    const upgraded = await call('/status');
    check(`after upgrade boot ${boot} the settled attempt reads exactly as it was left`, [
      upgraded.attempt, upgraded.stage, upgraded.error, upgraded.staged.parts, upgraded.staged.downloadedBytes, upgraded.staged.objects,
    ], [settledStatus.attempt, 'downloaded', settledStatus.error, settledStatus.staged.parts, settledStatus.staged.downloadedBytes, { registered: 0, staged: 0 }]);
    check(`after upgrade boot ${boot} no continuation advances the settled attempt`, (await call(`/continue?limits=${encodeURIComponent(wide)}`)).stage, 'idle');
    const unchanged = await call(`/staging-file?key=${encodeURIComponent(settledKey)}`);
    check(`after upgrade boot ${boot} its open manifest is unchanged`, JSON.stringify(unchanged.file), JSON.stringify(settledManifest.file));
    if (boot === 1) {
      await stop(worker!, 'SIGTERM');
      worker = null;
    }
  }
  const fresh = await call('/admit');
  check('a new admission on the upgraded storage is a new attempt', [fresh.attempt > settledStatus.attempt, fresh.stage], [true, 'export']);
  let freshStep = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  for (let step = 0; step < 64 && freshStep.nextInMs !== null; step += 1) freshStep = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  check('the new attempt runs the whole integrated path on the upgraded storage', [freshStep.stage, freshStep.error ?? null], ['complete', null]);
  const afterFresh = await call(`/staging-file?key=${encodeURIComponent(settledKey)}`);
  check('the settled attempt\'s manifest is still unchanged after a new attempt completes', JSON.stringify(afterFresh.file), JSON.stringify(settledManifest.file));

  // An attempt the previous producer admitted and left in flight: it carries no recorded admission, so the new
  // Worker finishes its export and rests it at `downloaded`, as the producer that admitted it would, never staging
  // objects or completing a manifest from what the staging holds.
  await stop(worker!, 'SIGTERM');
  worker = null;
  await startWorker(apiPort, 'manual', 'upgrade-inflight-state', previousEntry);
  await seed();
  const inflight = await call('/admit');
  const exporting = await call(`/continue?limits=${encodeURIComponent(STEP)}`);
  check('the previous producer leaves an attempt in flight, before its export is staged', ['export', 'download'].includes(exporting.stage), true);
  const inflightKey = `${inflight.staged.prefix}/recovery.json`;
  const inflightManifest = await call(`/staging-file?key=${encodeURIComponent(inflightKey)}`);
  await stop(worker!, 'SIGTERM');
  worker = null;
  await startWorker(apiPort, 'manual', 'upgrade-inflight-state');
  let carried = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  for (let step = 0; step < 64 && carried.nextInMs !== null; step += 1) carried = await call(`/continue?limits=${encodeURIComponent(wide)}`);
  const carriedStatus = await call('/status');
  check('the new Worker finishes an in-flight attempt it holds no admission record for at a staged export only', [
    carried.stage, carried.error ?? null, carriedStatus.staged.objects, carriedStatus.staged.downloadedBytes,
  ], ['downloaded', null, { registered: 0, staged: 0 }, EXPORT.byteLength]);
  const carriedManifest = await call(`/staging-file?key=${encodeURIComponent(inflightKey)}`);
  check('that attempt\'s open manifest is not rewritten', JSON.stringify(carriedManifest.file), JSON.stringify(inflightManifest.file));
  // The real clock, with a database it cannot read: an unmigrated D1 makes every tick raise, which is what an
  // export's own pause does to the source. Nothing below asks for a continuation: the clock's own alarm carries the
  // attempt across a kill and past the span one continuation may spend, and the provider is held to one export.
  await stop(worker!, 'SIGTERM');
  worker = null;
  const clockPort = await freePort();
  const clockProvider = stubProvider(clockPort, 1, { completeAfterMs: 25_000, pollDelayMs: 400 });
  try {
    await startWorker(clockPort, 'clock', 'clock-state');
    // This phase keeps its own state directory, so the Deployment's own objects are seeded into it as well.
    await seed();
    const clockPhase = routes.length;
    const admittedUnderClock = await call('/admit');
    check('an attempt is admitted while the database is unreadable by the tick', admittedUnderClock.stage, 'export');
    // The clock arms its own wake, as a Deployment does at boot. It is the only thing driving the attempt.
    await call('/ensure');
    await Bun.sleep(8_000);
    const midway = await call('/status');
    check('the clock alone advanced the export and saved a bookmark', [midway.stage, midway.export.polls >= 1, midway.export.bookmark], ['export', true, true]);

    const pollsAtKill = (await clockProvider.state()).polls;
    await stop(worker!, 'SIGKILL');
    worker = null;
    await startWorker(clockPort, 'clock', 'clock-state');
    const resumed = await call('/status');
    // An interrupted step is not announced as terminal: the log the killed version left carries no failure.
    const killedLog = fs.readFileSync(path.join(RUN, 'wrangler.log'), 'utf8');
    check('the killed version announced no terminal failure', /recovery_attempt_failed/.test(killedLog), false);
    check('a kill mid-export keeps the attempt, its polls and the bookmark it saved',
      [resumed.attempt, resumed.stage, resumed.export.polls >= midway.export.polls, resumed.export.bookmark],
      [midway.attempt, 'export', true, true]);

    // No arming of any kind after the restart: the alarm the clock had already stored is what carries the attempt on.
    const afterRestart = routes.length;
    let reached = resumed.stage;
    for (let attempt = 0; attempt < 300 && reached !== 'complete' && reached !== 'failed'; attempt += 1) {
      await Bun.sleep(500);
      reached = (await call('/status')).stage;
    }
    check("the clock's alarm carries the attempt to a complete staging with no continuation request", reached, 'complete');

    const seenByClock = await clockProvider.state();
    note('clock provider calls', {
      polls: seenByClock.polls, ranges: seenByClock.ranges, starts: seenByClock.starts,
      pollsAtKill, elapsedMs: seenByClock.completedAt - seenByClock.firstPollAt,
      firstBookmark: seenByClock.bookmarks[0], lastBookmark: seenByClock.bookmarks[seenByClock.bookmarks.length - 1],
    });
    check('one export was started, and every poll after the first carried the bookmark the checkpoint saved',
      [seenByClock.starts, seenByClock.bookmarks[0], seenByClock.bookmarks.slice(1).every((held: string | null) => typeof held === 'string')],
      [1, null, true]);
    check('the export was polled again after the kill, so it spanned more than one continuation', seenByClock.polls > pollsAtKill, true);
    check('the export outlived the span one continuation may spend', seenByClock.completedAt - seenByClock.firstPollAt >= 25_000, true);
    check('no continuation was requested in the clock phase', routes.slice(clockPhase).filter((route) => route.startsWith('/continue')), []);
    check('nothing was driven or armed after the restart', routes.slice(afterRestart).filter((route) => route !== '/status' && route !== '/staged' && route !== '/staging-file' && route !== '/wake'), []);
    const staged = await call(`/staged?attempt=${resumed.attempt}`);
    check('the clock-driven attempt staged the provider\'s own bytes', [staged.bytes, staged.sha256], [EXPORT.byteLength, await digestOf(EXPORT)]);

    const clockManifest = await call(`/staging-file?key=${encodeURIComponent(`${admittedUnderClock.staged.prefix}/recovery.json`)}`);
    check('the clock-driven staging is complete, with the export fingerprint and every object it names', [
      clockManifest.file.status, clockManifest.file.database.sha256,
      clockManifest.file.objects.map((object: { key: string }) => object.key).sort(),
    ], ['complete', await digestOf(EXPORT), Object.keys(SOURCE_OBJECTS).sort()]);

    const terminal = await call('/status');
    await Bun.sleep(3_000);
    const later = await call('/status');
    check('a staged attempt stays terminal under further wakes', [later.stage, later.staged.parts, later.staged.downloadedBytes], [terminal.stage, terminal.staged.parts, terminal.staged.downloadedBytes]);
    // The database really is unreadable in this configuration: an ordinary tick raises on it.
    const woke = await call('/wake');
    note('a wake once the attempt is terminal', woke);
    check('the tick raises on the unreadable database it held back from', woke.raised !== undefined, true);
  } finally { clockProvider.server.stop(true); }
  // A provider that refuses inside a success envelope, on real workerd.
  await stop(worker!, 'SIGTERM');
  worker = null;
  const refusingPort = await freePort();
  // It answers a running export until `/refuse` flips it to an inner refusal.
  const refusing = stubProvider(refusingPort, 99);
  try {
    await startWorker(refusingPort, 'manual', 'refusal-state');
    const admittedAgainstRefusal = await call('/admit');
    check('an attempt is admitted against a provider that will refuse', admittedAgainstRefusal.stage, 'export');
    // An export that runs and saves a bookmark, then a refusal of that bookmark: the export starts again once,
    // inside its bound.
    const polled = await call(`/continue?limits=${encodeURIComponent(STEP)}`);
    const holding = await call('/status');
    check('the attempt holds a bookmark before the refusal', [polled.stage, holding.export.bookmark], ['export', true]);
    await refusing.refuse();
    const restarted = await call(`/continue?limits=${encodeURIComponent(STEP)}`);
    const afterRestart = await call('/status');
    check('a refused bookmark restarts the export within its bound, and holds no signed download',
      [restarted.stage, afterRestart.export.reExports, afterRestart.export.bookmark], ['export', 1, false]);
    let refusalStage = admittedAgainstRefusal.stage;
    let drives = 0;
    while (refusalStage !== 'failed' && drives < 12) {
      refusalStage = (await call(`/continue?limits=${encodeURIComponent(STEP)}`)).stage;
      drives += 1;
    }
    const refusedStatus = await call('/status');
    check('an inner refusal ends the attempt instead of polling it forever',
      [refusalStage, refusedStatus.error, refusedStatus.stage], ['failed', 'export_failed', 'failed']);
    const seenByRefusal = await refusing.state();
    note('refusal provider calls', { polls: seenByRefusal.polls, drives, reExports: refusedStatus.export.reExports });
    check('the refusal was answered within the re-export bound, not by endless polling',
      [seenByRefusal.polls <= 8, refusedStatus.export.reExports <= 3], [true, true]);
    check('the source is not reported paused once the attempt is terminal', (await call('/continue')).sourcePaused, false);
    check('no provider text and no credential reached the owner status', /provider-controlled|Bearer/.test(JSON.stringify(refusedStatus)), false);
  } finally { refusing.server.stop(true); }
} catch (error) {
  failure = error;
  console.error(error);
} finally {
  if (worker !== null) await stop(worker, 'SIGTERM');
  provider.server.stop(true);
  const leftovers = owned.filter(({ pid }) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify({
    at: new Date().toISOString(), run: RUN, wrangler: Bun.spawnSync([WRANGLER, '--version'], { stdin: 'ignore' }).stdout.toString().trim().split('\n').pop(),
    passed: failure === null, failure: failure === null ? null : String(failure), checks, owned, leftovers,
  }, null, 2) + '\n');
  console.log(`${failure === null ? 'passed' : 'FAILED'}: ${checks.filter((entry) => 'check' in entry).length} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
  process.exit(failure === null ? 0 : 1);
}
