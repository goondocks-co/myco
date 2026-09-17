/**
 * Runtime proof for the operator backup hold on the native target, with the compiled binary.
 *
 * `myco server run` serves a real Deployment over HTTP in a disposable home, and `myco server backup` copies it while
 * it serves. What this proves cannot be proven in process: a start that takes its leases and runs its startup migration
 * for real, a backup holding a served volume while a deletion runs against it, a backup killed mid-copy leaving its
 * leases to the kernel and its hold in the database, the refusal an update gives while a backup holds the volume, and
 * the refusals a second server and an abandoned destination give.
 *
 * Every process it starts is stopped by its exact PID, and the run refuses if any is left behind.
 *
 * Usage: bun tests/server/runtime/operator-hold-runtime.ts [compiled binary]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';

const ROOT = path.resolve(import.meta.dir, '../../..');
const BINARY = process.argv[2] ?? path.join(ROOT, 'packages/myco-darwin-arm64/bin/myco');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-operator-hold-runtime-'));
const EVIDENCE = process.env.MYCO_OPERATOR_HOLD_EVIDENCE ?? path.join(RUN, 'result.json');
const HOME = path.join(RUN, 'home');
const checks: Array<Record<string, unknown>> = [];
/**
 * Every process this run starts, with the handle that says when it is gone.
 *
 * A SIGKILLed child of this process stays visible to `kill(pid, 0)` until it is reaped, so a leftover check that
 * only signals would report the run's own tidy shutdown as a process left behind.
 */
const owned: Array<{ what: string; pid: number; exited?: Promise<unknown> }> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 200)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const note = (label: string, value: unknown) => { checks.push({ note: label, value }); console.log(`note ${label}: ${JSON.stringify(value).slice(0, 240)}`); };
const descendants = (pid: number): number[] => Bun.spawnSync(['pgrep', '-P', String(pid)]).stdout.toString().trim().split('\n').filter(Boolean).map(Number).flatMap((child) => [child, ...descendants(child)]);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const kill = (pid: number) => { for (const target of [pid, ...descendants(pid)]) { try { process.kill(target, 'SIGKILL'); } catch { /* already gone */ } } };

/** One compiled command, run to completion with stdin closed. */
function cli(name: string, args: string[]) {
  const done = Bun.spawnSync([BINARY, ...args], { cwd: RUN, stdin: 'ignore', env: { ...process.env, MYCO_HOME: HOME, NO_COLOR: '1' }, timeout: 900_000 });
  const output = `${done.stdout.toString()}${done.stderr.toString()}`;
  fs.writeFileSync(path.join(RUN, `${name}.log`), `exit ${done.exitCode}\n${output}`);
  return { exit: done.exitCode, output, lines: output.split('\n').map((line) => line.trim()) };
}

const local = (...parts: string[]) => path.join(HOME, 'server', 'local', ...parts);
const database = () => local('myco.sqlite');
/**
 * Reads the volume the way its own Deployment does: read-write.
 *
 * A read-ONLY connection to a WAL database has to create the `-shm` it shares, so it only succeeds while some other
 * process already holds one. Every read here would work while the Deployment serves and fail the moment it stopped.
 */
const read = <T>(sql: string, params: unknown[] = []): T[] => {
  const sqlite = new Database(database(), { readwrite: true, create: false });
  try { sqlite.exec('PRAGMA busy_timeout = 5000'); return sqlite.query(sql).all(...(params as never[])) as T[]; } finally { sqlite.close(); }
};
const write = (sql: string, params: unknown[] = []) => {
  const sqlite = new Database(database());
  try { sqlite.exec('PRAGMA busy_timeout = 5000'); sqlite.run(sql, params as never[]); } finally { sqlite.close(); }
};
interface HoldRow { token: string; holder: string; released_at: number | null; release_reason: string | null; released_by: string | null }
const holds = () => read<HoldRow>('SELECT token, holder, released_at, release_reason, released_by FROM recovery_holds ORDER BY acquired_at, token');
const openHolds = () => holds().filter((row) => row.released_at === null);
const schemaVersion = () => read<{ value: string }>("SELECT value FROM schema_meta WHERE key = 'version'")[0]!.value;

/** A serving Deployment, in its own process, answering on its own address. */
async function serve(name: string): Promise<{ pid: number; port: number; stop: () => Promise<void> }> {
  const log = fs.openSync(path.join(RUN, `${name}.log`), 'a');
  const proc = Bun.spawn([BINARY, 'server', 'run', '--target', 'local', '--no-worker'], {
    cwd: RUN, stdin: 'ignore', stdout: log, stderr: log, env: { ...process.env, MYCO_HOME: HOME, NO_COLOR: '1' },
  });
  owned.push({ what: `server run ${name}`, pid: proc.pid, exited: proc.exited });
  const port = Number(JSON.parse(fs.readFileSync(local('server.json'), 'utf8')).port);
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })).ok) {
        return {
          pid: proc.pid,
          port,
          stop: async () => {
            const tree = [proc.pid, ...descendants(proc.pid)];
            for (const pid of tree) { try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ } }
            await Promise.race([proc.exited, Bun.sleep(30_000)]);
            for (const pid of tree) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
            await proc.exited;
          },
        };
      }
    } catch { /* not serving yet */ }
    if (proc.exitCode !== null) throw new Error(`${name} exited ${proc.exitCode}: ${fs.readFileSync(path.join(RUN, `${name}.log`), 'utf8').slice(-800)}`);
    await Bun.sleep(250);
  }
  throw new Error(`${name} did not answer within 180s`);
}

/** A backup started in its own process, waited on until it has taken and bound its hold. */
async function backupUntilHeld(name: string, destination: string): Promise<{ proc: ReturnType<typeof Bun.spawn>; hold: HoldRow }> {
  const proc = Bun.spawn([BINARY, 'server', 'backup', '--target', 'local', '--to', destination], {
    cwd: RUN, stdin: 'ignore', stdout: fs.openSync(path.join(RUN, `${name}.log`), 'a'), stderr: 'ignore',
    env: { ...process.env, MYCO_HOME: HOME, NO_COLOR: '1' },
  });
  owned.push({ what: `server backup ${name}`, pid: proc.pid, exited: proc.exited });
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const open = openHolds();
    if (fs.existsSync(path.join(destination, '.recovery-hold-bound.json')) && open.length === 1) return { proc, hold: open[0]! };
    if (proc.exitCode !== null) throw new Error(`${name} exited ${proc.exitCode} before it held anything`);
    await Bun.sleep(50);
  }
  throw new Error(`${name} did not take and bind a hold within 120s`);
}

let failure: unknown = null;
try {
  fs.mkdirSync(HOME, { recursive: true });
  note('the binary', cli('00-version', ['--version']).output.trim());
  check('the compiled binary creates a native Deployment', cli('01-create', ['server', 'create', '--target', 'local', '--port', '8799']).exit, 0);
  check('it starts at this binary\'s schema', schemaVersion(), '43');

  // One registered object, as an upload registers it: its stored name carries its generation.
  const bytes = new TextEncoder().encode('an object a backup must keep');
  const key = new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
  const generation = crypto.randomUUID();
  fs.mkdirSync(local('blobs', 'proj_1'), { recursive: true });
  fs.writeFileSync(local('blobs', 'proj_1', `${key}~${generation}`), bytes);
  write("INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', ?, ?, 'text/plain', 'mt_runtime', 1, ?)", [key, bytes.length, generation]);

  /*
   * Enough objects that a copy takes long enough to be interrupted.
   *
   * The proofs below need a backup that is RUNNING: one that has taken and bound its hold and is still copying. A
   * volume holding a single small object is copied faster than anything can observe, so the interruption those
   * proofs depend on would be a race decided by disk speed. This is also what a real volume looks like.
   */
  const FILLER_OBJECTS = 600;
  const filler = new Uint8Array(16 * 1024);
  for (let made = 0; made < FILLER_OBJECTS; made += 1) {
    crypto.getRandomValues(filler.subarray(0, 32));
    const fillerKey = new Bun.CryptoHasher('sha256').update(filler).digest('hex');
    const fillerGeneration = crypto.randomUUID();
    fs.writeFileSync(local('blobs', 'proj_1', `${fillerKey}~${fillerGeneration}`), filler);
    write("INSERT INTO blobs (project_id, key, size, media_type, token_id, received_at, generation) VALUES ('proj_1', ?, ?, 'application/octet-stream', 'mt_runtime', 1, ?)",
      [fillerKey, filler.length, fillerGeneration]);
  }
  note('objects this volume holds', read<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')[0]!.n);

  // A backup while the Deployment serves.
  const serving = await serve('02-serve');
  check('the Deployment answers on its own address', (await fetch(`http://127.0.0.1:${serving.port}/health`)).status, 200);
  const first = cli('03-backup', ['server', 'backup', '--target', 'local', '--to', path.join(RUN, 'artifact')]);
  check('a backup completes while it serves', [first.exit, first.lines.some((line) => line.startsWith('Verified data artifact written to'))], [0, true]);
  check('its hold was taken and released', holds().map((row) => [row.holder, row.release_reason, row.released_by]), [['operator', 'complete', 'operator']]);
  check('the Deployment is still answering', (await fetch(`http://127.0.0.1:${serving.port}/health`)).status, 200);
  check('status reports no hold once it is released', cli('04-status', ['server', 'status', '--target', 'local']).output.includes('Backup hold'), false);

  // A backup killed mid-copy: the kernel takes its leases, the database keeps its hold.
  const interrupted = path.join(RUN, 'artifact-interrupted');
  const killed = await backupUntilHeld('05-backup-killed', interrupted);
  killed.proc.kill(9);
  await killed.proc.exited;
  check('a killed backup leaves its hold open', openHolds().map((row) => [row.token === killed.hold.token, row.holder]), [[true, 'operator']]);
  const inspected = cli('06-recovery-hold', ['server', 'recovery-hold', '--target', 'local', '--to', interrupted]);
  check('that hold is reported against its destination', [inspected.exit, inspected.output.includes(killed.hold.token), inspected.output.includes('is open')], [0, true, true]);
  check('status names the open hold and what it defers', [
    cli('07-status-held', ['server', 'status', '--target', 'local']).output.includes(killed.hold.token),
    cli('07-status-held', ['server', 'status', '--target', 'local']).output.includes('deferred'),
  ], [true, true]);

  // The deletion that would have freed the held object is refused outside the release journal, and the object stays.
  let refusedDelete = '';
  try { write('DELETE FROM blobs WHERE key = ?', [key]); } catch (error) { refusedDelete = String(error).slice(0, 120); }
  note('a delete outside the release journal', refusedDelete);
  check('the held object is still registered and still stored', [
    read<{ n: number }>('SELECT COUNT(*) AS n FROM blobs')[0]!.n,
    fs.existsSync(local('blobs', 'proj_1', `${key}~${generation}`)),
  ], [FILLER_OBJECTS + 1, true]);

  // Resuming completes the artifact under the same hold, and releases exactly it.
  const resumed = cli('08-resume', ['server', 'backup', '--target', 'local', '--to', interrupted]);
  check('resuming under the same hold completes the artifact', [resumed.exit, resumed.lines.some((line) => line.startsWith('Verified data artifact written to'))], [0, true]);
  check('and releases exactly that hold', holds().filter((row) => row.token === killed.hold.token).map((row) => [row.release_reason, row.released_by]), [['complete', 'operator']]);
  await serving.stop();

  // A start that must migrate, while an operator backup holds the volume: the backup keeps it and the start says so.
  write("UPDATE schema_meta SET value = '42' WHERE key = 'version'");
  check('the volume now reads behind this binary', schemaVersion(), '42');
  const holding = path.join(RUN, 'holding');
  const releaseFile = path.join(RUN, 'release-hold');
  const volumeHolder = Bun.spawn(['bun', '-e', `
    import { LocalVolume } from ${JSON.stringify(path.join(ROOT, 'packages/myco/src/server/local-volume.ts'))};
    import { resolveLocalPaths } from ${JSON.stringify(path.join(ROOT, 'packages/myco/src/server/local.ts'))};
    await new LocalVolume(resolveLocalPaths(${JSON.stringify(HOME)})).reading(async () => {
      await Bun.write(${JSON.stringify(holding)}, 'held');
      while (!(await Bun.file(${JSON.stringify(releaseFile)}).exists())) await Bun.sleep(25);
    });
  `], { cwd: ROOT, stdin: 'ignore', stdout: 'ignore', stderr: fs.openSync(path.join(RUN, '09-volume-holder.log'), 'a') });
  owned.push({ what: 'an operator backup holding the volume', pid: volumeHolder.pid, exited: volumeHolder.exited });
  for (let attempt = 0; attempt < 400 && !fs.existsSync(holding); attempt += 1) await Bun.sleep(50);
  check('an operator backup holds the volume', fs.existsSync(holding), true);
  const refusedUpdate = cli('10-update-refused', ['server', 'update', '--target', 'local']);
  check('an update that must migrate is refused while it holds the volume', [refusedUpdate.exit, refusedUpdate.output.includes('volume is in use')], [1, true]);
  check('the volume is untouched by that refusal', schemaVersion(), '42');
  fs.writeFileSync(releaseFile, '');
  await volumeHolder.exited;
  const migrated = cli('11-update', ['server', 'update', '--target', 'local']);
  check('the same update migrates once the backup releases the volume', [migrated.exit, schemaVersion()], [0, '43']);

  // One server per volume, a backup beside a serving Deployment, and the abandonment path.
  const again = await serve('12-serve');
  const second = cli('13-second-serve', ['server', 'run', '--target', 'local', '--no-worker']);
  check('a second serving process is refused', [second.exit, second.output.includes('already served by another process')], [1, true]);
  check('a backup runs beside the serving Deployment', cli('14-backup-alongside', ['server', 'backup', '--target', 'local', '--to', path.join(RUN, 'artifact-alongside')]).exit, 0);
  check('the Deployment is still answering', (await fetch(`http://127.0.0.1:${again.port}/health`)).status, 200);

  const abandonable = path.join(RUN, 'artifact-abandoned');
  const abandonedBackup = await backupUntilHeld('15-backup-abandoned', abandonable);
  abandonedBackup.proc.kill(9);
  await abandonedBackup.proc.exited;
  const abandon = cli('16-abandon', ['server', 'recovery-hold', '--target', 'local', '--to', abandonable, '--abandon']);
  check('abandoning releases exactly that hold', [
    abandon.exit,
    abandon.output.includes('is released'),
    holds().filter((row) => row.token === abandonedBackup.hold.token).map((row) => row.release_reason),
  ], [0, true, ['abandoned']]);
  const refusedResume = cli('17-resume-refused', ['server', 'backup', '--target', 'local', '--to', abandonable]);
  check('an abandoned destination cannot be resumed', [refusedResume.exit, refusedResume.output.includes('capture into a new directory')], [1, true]);

  const producerToken = crypto.randomUUID();
  write('INSERT INTO recovery_holds (token, acquired_at) VALUES (?, ?)', [producerToken, Date.now()]);
  const refusedProducer = cli('18-abandon-producer', ['server', 'recovery-hold', '--target', 'local', '--token', producerToken, '--abandon', '--yes']);
  check("abandoning refuses this Deployment's own export hold", [refusedProducer.exit, openHolds().some((row) => row.token === producerToken)], [1, true]);
  await again.stop();
} catch (error) {
  failure = error;
  console.log(`FAILED: ${String(error).slice(0, 600)}`);
} finally {
  for (const { pid } of owned) kill(pid);
  // Reaped, not just signalled, so what is counted below is what is still running.
  await Promise.all(owned.map(({ exited }) => exited === undefined ? Promise.resolve() : Promise.race([exited, Bun.sleep(10_000)])));
}
const leftovers = owned.filter(({ pid }) => alive(pid));
const passed = checks.filter((entry) => entry.ok === true).length;
fs.writeFileSync(EVIDENCE, JSON.stringify({
  at: new Date().toISOString(), binary: BINARY, run: RUN, passed, total: checks.filter((entry) => 'check' in entry).length,
  failure: failure === null ? null : String(failure).slice(0, 600), owned, leftovers: leftovers.length, checks,
}, null, 2));
console.log(`${failure === null && leftovers.length === 0 ? 'passed' : 'FAILED'}: ${passed} checks; evidence ${EVIDENCE}; leftovers ${leftovers.length}`);
process.exitCode = failure === null && leftovers.length === 0 ? 0 : 1;
