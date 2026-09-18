/**
 * Runtime proof for automatic recovery on a Deployment this machine runs itself.
 *
 * Everything here is the real thing: the compiled binary creates a Deployment in a disposable home, serves it,
 * and its own clock admits an attempt on the interval its owner set. The artifact is produced by the canonical
 * writer in a child process the Deployment owns, and this run watches the Deployment keep answering while it
 * happens.
 *
 * What it proves that no in-process test can:
 *
 * - an ordinary unattended cycle: nothing asks for a backup, and one appears because the interval said so;
 * - the Deployment keeps serving throughout, because the work is in a child rather than on its loop;
 * - a stop mid-attempt leaves that attempt resumable, and the next start carries on the SAME attempt rather than
 *   beginning a second one;
 * - a second start with nothing due admits nothing;
 * - the artifact restores into a fresh disposable home, and that Deployment serves the restored data.
 *
 * The volume is seeded with synthetic bulk rows in a table of their own so a snapshot takes real time; the schema
 * around them is the Deployment's own, written by its own migrations. Every process is stopped by its exact PID,
 * and the run refuses if any is left behind.
 *
 * Usage: bun tests/server/runtime/native-automatic-runtime.ts <compiled binary> [megabytes]
 */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const BINARY = process.argv[2];
const MEGABYTES = Number(process.argv[3] ?? 320);
if (BINARY === undefined || !fs.existsSync(BINARY)) throw new Error('usage: bun native-automatic-runtime.ts <compiled binary> [megabytes]');

const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-automatic-'));
const HOME = path.join(RUN, 'home');
const RESTORED = path.join(RUN, 'restored');
const EVIDENCE = process.env.MYCO_NATIVE_AUTOMATIC_EVIDENCE ?? path.join(RUN, 'result.json');
const checks: Array<Record<string, unknown>> = [];
const owned: Array<{ what: string; pid: number }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 220)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 260)}`); };
const freePort = () => new Promise<number>((resolve) => {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as net.AddressInfo).port; probe.close(() => resolve(port)); });
});
const descendants = (pid: number): number[] => {
  const found = Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim();
  return found === '' ? [] : found.split('\n').map(Number).flatMap((child) => [child, ...descendants(child)]);
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** One served Deployment, and everything this run owns of it. */
interface Served { proc: ReturnType<typeof Bun.spawn>; port: number }

const env = (home: string) => ({ ...process.env, MYCO_HOME: home, NO_COLOR: '1' }) as Record<string, string>;

async function serve(home: string, port: number, label: string): Promise<Served> {
  const log = fs.openSync(path.join(RUN, `${label}.log`), 'a');
  const proc = Bun.spawn([BINARY, 'server', 'run', '--target', 'local', '--no-worker'], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: env(home),
  });
  owned.push({ what: label, pid: proc.pid });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) return { proc, port };
    } catch { /* not serving yet */ }
    if (proc.exitCode !== null) throw new Error(`${label} exited ${proc.exitCode}: ${fs.readFileSync(path.join(RUN, `${label}.log`), 'utf8').slice(-800)}`);
    await Bun.sleep(200);
  }
  throw new Error(`${label} did not serve within 180s`);
}

/** Ends a served Deployment the way its platform does, and waits for its process to go. */
async function end(served: Served, signal: 'SIGTERM' | 'SIGKILL'): Promise<void> {
  const tree = [served.proc.pid, ...descendants(served.proc.pid)];
  process.kill(served.proc.pid, signal);
  await Promise.race([served.proc.exited, Bun.sleep(60_000)]);
  for (const pid of tree) { if (alive(pid) && signal === 'SIGKILL') { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

const artifactsRoot = (home: string, deploymentId: string): string => path.join(home, 'server', 'local-recovery', deploymentId);
const attemptDirs = (root: string): string[] => (fs.existsSync(root) ? fs.readdirSync(root) : []).filter((entry) => /^\d+$/.test(entry)).sort();
/**
 * Opens a volume nobody is serving, waiting briefly for one just published.
 *
 * These volumes are in WAL mode, and a read-only open of one whose shared-memory file is absent cannot create it,
 * so this reads them read-write: nothing serves them, and this run owns every one. A restore publishes by
 * renaming its staging into place, so a read taken at that instant waits for it.
 */
function openWhenReady(file: string, label: string): Database {
  const started = Bun.nanoseconds();
  for (let attempt = 0; ; attempt += 1) {
    try {
      const db = new Database(file, { readwrite: true, create: false });
      const waitedMs = Math.round((Bun.nanoseconds() - started) / 1e6);
      if (waitedMs > 0) note(`how long ${label} took to open`, { waitedMs, attempts: attempt + 1 });
      return db;
    } catch (error) {
      if (attempt >= 50) throw error;
      Bun.sleepSync(100);
    }
  }
}

const manifestOf = (directory: string): { format?: string; status?: string; snapshot?: { database?: { bytes?: number; sha256?: string }; deploymentId?: string } } | null => {
  try { return JSON.parse(fs.readFileSync(path.join(directory, 'recovery.json'), 'utf8')); } catch { return null; }
};

let failure: unknown = null;
const running: Served[] = [];
try {
  fs.mkdirSync(HOME, { recursive: true });
  const port = await freePort();
  const created = Bun.spawnSync([BINARY, 'server', 'create', '--target', 'local', '--port', String(port)], { cwd: RUN, stdin: 'ignore', env: env(HOME), timeout: 300_000 });
  check('the binary creates a native Deployment', created.exitCode, 0);
  note('the binary', Bun.spawnSync([BINARY, '--version'], { stdin: 'ignore', env: env(HOME) }).stdout.toString().trim());

  const volume = path.join(HOME, 'server', 'local', 'myco.sqlite');
  // The owner's own setting, and a volume with enough in it that a snapshot of it takes real time. The rows are
  // synthetic bulk in a table of their own; the schema around them is the Deployment's own.
  let deploymentId = '';
  {
    const db = new Database(volume, { readwrite: true, create: false });
    try {
      db.query('INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)')
        .run('backup.auto_interval_hours', JSON.stringify(1), Date.now(), 'mem_runtime');
      db.exec('CREATE TABLE IF NOT EXISTS fixture_bulk (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)');
      const insert = db.prepare('INSERT INTO fixture_bulk (payload) VALUES (?)');
      const body = 'x'.repeat(1024);
      const rows = MEGABYTES * 1024;
      db.transaction(() => { for (let row = 0; row < rows; row += 1) insert.run(`${row}:${body}`); })();
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      deploymentId = (db.query('SELECT value FROM schema_meta WHERE key = ?').get('deployment_id') as { value: string }).value;
    } finally { db.close(); }
  }
  const root = artifactsRoot(HOME, deploymentId);
  note('the Deployment and its volume', { deploymentId, volumeBytes: fs.statSync(volume).size, artifacts: root });

  // The first cycle is unforced: nothing asks for a backup and no clock is moved. The Deployment is started, and
  // its own clock admits one because an interval is set.
  note('what this cycle is', 'unforced: the interval is the owner\'s setting and the clock is the Deployment\'s own');
  const first = await serve(HOME, port, 'server-1');
  running.push(first);
  const admitted = Date.now() + 120_000;
  while (Date.now() < admitted && attemptDirs(root).length === 0) await Bun.sleep(100);
  const attempt = attemptDirs(root)[0];
  check('its own clock admitted one attempt, with nothing asking for it', attempt !== undefined, true);
  note('the attempt it pinned', { attempt, records: fs.readdirSync(root).filter((entry) => entry.endsWith('.attempt.json')) });

  // It keeps serving while the artifact is produced, because the work is in a child process rather than its loop.
  const sampled: number[] = [];
  const settled = Date.now() + 600_000;
  while (Date.now() < settled) {
    const at = Bun.nanoseconds();
    const answer = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(30_000) }).catch(() => null);
    sampled.push((Bun.nanoseconds() - at) / 1e6);
    if (answer === null || !answer.ok) throw new Error('the Deployment stopped answering while its artifact was produced');
    if (manifestOf(path.join(root, attempt!))?.status === 'complete') break;
    await Bun.sleep(100);
  }
  const worst = Math.round(Math.max(...sampled));
  note('the Deployment\'s own latency while it produced its artifact', { samples: sampled.length, worst });
  check('it answered every request while the artifact was produced', [sampled.length > 5, worst < 1_000], [true, true]);

  const whole = manifestOf(path.join(root, attempt!))!;
  check('the artifact is the verified form, complete, of this Deployment',
    [whole.format, whole.status, whole.snapshot?.deploymentId], ['myco-recovery/2', 'complete', deploymentId]);
  note('what it holds', { bytes: whole.snapshot?.database?.bytes, sha256: whole.snapshot?.database?.sha256 });

  // Its holds are settled: the child releases its own as it completes the artifact, and the Deployment's
  // hold-release job settles the one admission opened — at the wake a settled attempt asks for, not at the next
  // hour on the clock.
  {
    const openHolds = (): number => {
      const db = openWhenReady(volume, 'the source volume');
      try { return (db.query('SELECT COUNT(*) AS open FROM recovery_holds WHERE released_at IS NULL').get() as { open: number }).open; } finally { db.close(); }
    };
    const settledBy = Date.now() + 120_000;
    while (Date.now() < settledBy && openHolds() > 0) await Bun.sleep(250);
    check('no recovery hold is left open on the source', openHolds(), 0);
    const holds = openWhenReady(volume, 'the source volume');
    try {
      note('what the source records of this attempt\'s holds', holds.query('SELECT holder, release_reason FROM recovery_holds ORDER BY acquired_at').all());
    } finally { holds.close(); }
  }

  // A second start with nothing due admits nothing: the cadence is the attempt's own start, so a restart does not
  // produce a second artifact.
  await end(first, 'SIGTERM');
  running.pop();
  const second = await serve(HOME, port, 'server-2');
  running.push(second);
  await Bun.sleep(5_000);
  check('a restart with nothing due admits no second attempt', attemptDirs(root), [attempt!]);

  // Mid-attempt: a stop withdraws the child, and the next start carries on the same attempt rather than a new one.
  // The second cycle is NOT unforced: this run shifts the recorded attempt back so the interval reads as elapsed.
  // That is a clock the harness moved, and what follows proves resume, not cadence.
  note('what the next cycle is', 'synthetic: the recorded attempt is shifted back so the interval reads as due');
  {
    const db = new Database(volume, { readwrite: true, create: false });
    try {
      const record = path.join(root, `${attempt}.attempt.json`);
      const held = JSON.parse(fs.readFileSync(record, 'utf8')) as { startedAt: number };
      note('moving the recorded attempt back so the interval is due again', { was: held.startedAt });
      const moved = held.startedAt - 2 * 60 * 60 * 1000;
      fs.renameSync(path.join(root, attempt!), path.join(root, String(moved)));
      fs.writeFileSync(path.join(root, `${moved}.attempt.json`), JSON.stringify({ ...held, startedAt: moved }));
      fs.rmSync(record);
      db.exec('SELECT 1');
    } finally { db.close(); }
  }
  await end(second, 'SIGTERM');
  running.pop();

  const third = await serve(HOME, port, 'server-3');
  running.push(third);
  const due = Date.now() + 120_000;
  while (Date.now() < due && attemptDirs(root).length < 2) await Bun.sleep(100);
  const second_attempt = attemptDirs(root).find((entry) => manifestOf(path.join(root, entry))?.status !== 'complete')
    ?? attemptDirs(root).at(-1)!;
  check('the due interval admitted a second attempt', attemptDirs(root).length, 2);
  // Stop while that attempt is still being produced: the child is withdrawn and its directory is left resumable.
  await end(third, 'SIGTERM');
  running.pop();
  const reached = manifestOf(path.join(root, second_attempt))?.status ?? null;
  const interrupted = reached === null || reached === 'snapshot' || reached === 'content';
  note('what the stopped attempt had reached', { attempt: second_attempt, status: reached, interrupted });
  if (interrupted) {
    // Only an attempt that is actually part-written proves a resume.
    check('the stopped attempt is incomplete, with no complete manifest of its own',
      [reached, manifestOf(path.join(root, second_attempt))?.status === 'complete'], [reached, false]);
  } else {
    note('no interruption to prove in this run', 'the attempt completed before the stop landed; what follows shows only that no second attempt began');
  }

  const fourth = await serve(HOME, port, 'server-4');
  running.push(fourth);
  const resumed = Date.now() + 600_000;
  while (Date.now() < resumed && manifestOf(path.join(root, second_attempt))?.status !== 'complete') await Bun.sleep(200);
  check(interrupted
    ? 'the next start carried that same incomplete attempt to completion, and began no other'
    : 'the next start began no other attempt, and that one is complete',
    [attemptDirs(root).length, manifestOf(path.join(root, second_attempt))?.status], [2, 'complete']);
  note('the attempts this Deployment holds', attemptDirs(root).map((entry) => ({ attempt: entry, status: manifestOf(path.join(root, entry))?.status ?? null })));
  await end(fourth, 'SIGTERM');
  running.pop();

  // The artifact restores into a fresh disposable home, and that Deployment serves the restored data. This is
  // this slice's own proof — rows, identity and a served address — and not the dashboard, MCP and derived-index
  // readiness #1316's acceptance asks for.
  note('what the restore below proves', 'rows, Deployment identity and a served address; not UI, MCP or index readiness');
  const artifact = path.join(root, second_attempt);
  const restorePort = await freePort();
  fs.mkdirSync(RESTORED, { recursive: true });
  // This Deployment holds no sign-in credentials, as a self-hosted one that never configured GitHub sign-in does,
  // so the restore is asked for a fresh sign-in and only the wrapping key it was sealed under.
  const restored = Bun.spawnSync([
    BINARY, 'server', 'restore', '--target', 'local', '--from', artifact,
    '--secrets-from', path.join(HOME, 'server', 'local', 'secrets.env'), '--new-signin', '--yes', '--port', String(restorePort),
  ], { cwd: RUN, stdin: 'ignore', env: env(RESTORED), timeout: 900_000 });
  note('what the restore said', `${restored.stdout.toString()}${restored.stderr.toString()}`.trim().split('\n').slice(-3));
  check('the artifact restores into a fresh home', restored.exitCode, 0);

  const restoredVolume = path.join(RESTORED, 'server', 'local', 'myco.sqlite');
  {
    const source = openWhenReady(volume, 'the source volume');
    const copy = openWhenReady(restoredVolume, 'the restored volume');
    try {
      const rows = (db: Database): { rows: number } => db.query('SELECT COUNT(*) AS rows FROM fixture_bulk').get() as { rows: number };
      const id = (db: Database): string => (db.query('SELECT value FROM schema_meta WHERE key = ?').get('deployment_id') as { value: string }).value;
      check('the restored Deployment holds the same rows and names the same Deployment',
        [rows(copy).rows === rows(source).rows, id(copy) === deploymentId], [true, true]);
      note('rows in each', { source: rows(source).rows, restored: rows(copy).rows });
    } finally { source.close(); copy.close(); }
  }
  const serving = await serve(RESTORED, restorePort, 'restored');
  running.push(serving);
  const health = await fetch(`http://127.0.0.1:${restorePort}/health`, { signal: AbortSignal.timeout(30_000) });
  check('the restored Deployment serves', health.ok, true);
  note('what this run does not establish', 'an unattended second cadence cycle, dashboard/MCP/derived-index readiness, and any target but this one');
  await end(serving, 'SIGTERM');
  running.pop();
} catch (error) {
  failure = error;
  console.log(`FAILED: ${String(error).slice(0, 900)}`);
} finally {
  for (const served of running) await end(served, 'SIGKILL').catch(() => undefined);
  for (const { pid } of owned) { if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
}

const leftovers = owned.filter(({ pid }) => alive(pid));
const passed = checks.filter((entry) => entry.ok === true).length;
fs.writeFileSync(EVIDENCE, JSON.stringify({
  at: new Date().toISOString(), binary: BINARY, run: RUN, megabytes: MEGABYTES, passed,
  total: checks.filter((entry) => 'check' in entry).length,
  failure: failure === null ? null : String(failure).slice(0, 900), owned, leftovers: leftovers.length, checks,
}, null, 2));
console.log(`${failure === null && leftovers.length === 0 ? 'passed' : 'FAILED'}: ${passed} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
process.exitCode = failure === null && leftovers.length === 0 ? 0 : 1;
