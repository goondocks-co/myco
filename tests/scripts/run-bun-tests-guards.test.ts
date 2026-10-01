/**
 * Two guards of the test runner, each driven through the real runner:
 *   - a test group never reads the runner's stdin, so a test that reads fd 0
 *     finishes even when `npm test` was started with a stdin that never ends
 *     (a terminal, or an agent harness's socket);
 *   - a group still running at its wall-clock budget is sampled, killed with
 *     its whole process tree, and reported failed with its test files, and
 *     the run goes on;
 *   - a run leaves nothing in the temp directory, whatever its tests leak and
 *     however it ends (at the end, by a signal, or of an uncaught error, which
 *     also puts a swapped bunfig back), and sweeps the roots of earlier runs
 *     whose runner is gone while keeping those of runs still going.
 * The fixtures are skipped unless these tests set their flags.
 */
import { describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactSecrets } from '../../scripts/redact-secrets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANG_FIXTURE = 'tests/fixtures/runner/budget_hang_test.ts';
const STDIN_FIXTURE = 'tests/fixtures/runner/stdin_read_test.ts';
const TEMP_LEAK_FIXTURE = 'tests/fixtures/runner/temp_leak_test.ts';
const STREAM_FAULT_FIXTURE = 'tests/fixtures/runner/stream_fault_test.tsx';
const BUDGET_MS = 3000;
// Sampling takes a few seconds per process; anything near this bound means a guard did not fire.
const RUN_BOUND_MS = 90_000;

interface RunnerResult { status: number | null; output: string; elapsedMs: number }

/**
 * Run the runner on one target. Its stdin is a pipe this side never closes, as a harness's can be. The outer
 * run's own runner settings (a CI shard, a test kind, a plan file) are not passed on: the nested run is one group.
 */
function runRunner(
  target: string,
  env: Record<string, string>,
  args: string[] = [],
  onSpawn: (runner: ChildProcess) => void = () => {},
): Promise<RunnerResult> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('node', ['scripts/run-bun-tests.mjs', target, ...args], {
      cwd: REPO, env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    onSpawn(child);
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const bound = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`runner still running after ${RUN_BOUND_MS}ms:\n${output}`)); }, RUN_BOUND_MS);
    child.on('close', (status) => {
      clearTimeout(bound);
      child.stdin.destroy();
      resolve({ status, output, elapsedMs: Date.now() - started });
    });
  });
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** Every live pid whose process group is `pgid`. */
function processGroupMembers(pgid: number): number[] {
  const table = spawnSync('ps', ['-axo', 'pid=,pgid='], { encoding: 'utf8' }).stdout;
  return table.split('\n').map((line) => line.trim().split(/\s+/).map(Number)).filter(([, group]) => group === pgid).map(([pid]) => pid);
}

function withReportDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-guards-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

describe('run-bun-tests guards', () => {
  test('a test group reads EOF on stdin even when the runner\'s stdin stays open', () => withReportDir(async (reports) => {
    const { status, output } = await runRunner(STDIN_FIXTURE, {
      MYCO_RUNNER_STDIN_FIXTURE: '1',
      // A group that blocked on stdin is killed here and fails, rather than holding the test to its bound.
      MYCO_RUNNER_GROUP_BUDGET_MS: '20000',
      MYCO_RUNNER_HEARTBEAT_INTERVAL_MS: '1000',
      MYCO_RUNNER_REPORT_DIR: reports,
    });
    expect({ status, output }).toEqual({ status: 0, output: expect.stringContaining(' 1 pass') });
  }), RUN_BOUND_MS + 10_000);

  test('samples, kills and fails a group that outlives its budget, leaving none of its processes', () => withReportDir(async (reports) => {
    const pidsFile = path.join(reports, 'fixture-children.pids');
    const { status, output, elapsedMs } = await runRunner(HANG_FIXTURE, {
      MYCO_RUNNER_HANG_FIXTURE: '1',
      MYCO_RUNNER_HANG_PIDS_FILE: pidsFile,
      MYCO_RUNNER_GROUP_BUDGET_MS: String(BUDGET_MS),
      MYCO_RUNNER_HEARTBEAT_INTERVAL_MS: '1000',
      MYCO_RUNNER_REPORT_DIR: reports,
    }, ['-t', 'blocks|token=s3cr3tvalue123']);

    expect(status).toBe(124);
    expect(elapsedMs).toBeLessThan(RUN_BOUND_MS);
    expect(output).toContain('KILLED (over budget) node env');
    expect(output).toMatch(new RegExp(`=== OVER BUDGET \\(killed at ${BUDGET_MS}ms\\) ===[\\s\\S]*${HANG_FIXTURE.replace(/\./g, '\\.')}`));

    const junit = fs.readFileSync(path.join(reports, 'node-env.junit.xml'), 'utf8');
    expect(junit).toContain(`file="${HANG_FIXTURE}"`);
    expect(junit).toContain('<failure type="GroupBudgetExceeded"');

    const hang = fs.readFileSync(path.join(reports, 'node-env.hang.txt'), 'utf8');
    expect(hang).toContain('--- lsof');
    expect(hang).toContain(process.platform === 'darwin' ? '--- sample (3s)' : '/proc/');
    // The token-like value on the group's command line is never written out.
    expect(hang).not.toContain('s3cr3tvalue123');
    expect(hang).toContain('token=<redacted>');

    // Nothing the group started survives: neither child the fixture started, nor any member of its process group.
    const children = fs.readFileSync(pidsFile, 'utf8').trim().split(' ').map(Number);
    expect(children).toHaveLength(2);
    // The group's leader is the row of the captured `ps` whose pid is its own process group.
    const psRows = hang.split('\n').map((line) => line.trim().split(/\s+/)).filter((cols) => /^\d+$/.test(cols[0] ?? '') && /^\d+$/.test(cols[2] ?? ''));
    const pgid = Number(psRows.find((cols) => cols[0] === cols[2])?.[0]);
    expect(Number.isInteger(pgid)).toBe(true);
    for (const pid of [...children, ...hang.match(/^pids: (.+)$/m)![1].split(' ').map(Number)]) expect({ pid, alive: alive(pid) }).toEqual({ pid, alive: false });
    expect(processGroupMembers(pgid)).toEqual([]);
  }), RUN_BOUND_MS + 10_000);
});

/** The temp directory a nested run is given, as every variable that names one on any platform. */
function tempDirEnv(dir: string): Record<string, string> {
  return { TMPDIR: dir, TEMP: dir, TMP: dir };
}

/** A report directory and, beside it (the runner clears its report directory), a temp directory for a nested run. */
function withRunDirs<T>(fn: (dirs: { reports: string; tempDir: string }) => Promise<T>): Promise<T> {
  return withReportDir((dir) => {
    const tempDir = path.join(dir, 'tmp');
    fs.mkdirSync(tempDir);
    return fn({ reports: path.join(dir, 'reports'), tempDir });
  });
}

/** Everything in `dir`, sorted. */
function entries(dir: string): string[] {
  return fs.readdirSync(dir).sort();
}

/** A run root as a runner leaves it, with something inside, owned by `pid` or, with null, by no one yet. */
function seedRunRoot(parent: string, name: string, pid: number | null): string {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, 'h-seeded'), { recursive: true });
  if (pid !== null) fs.writeFileSync(path.join(root, '.owner'), `${pid}\n`);
  return root;
}

async function waitFor(condition: () => boolean, boundMs: number, what: string): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`still waiting after ${boundMs}ms for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('run-bun-tests temp containment', () => {
  test('a run leaves nothing in the temp directory, and sweeps only the roots of runners that are gone', () => withRunDirs(async ({ reports, tempDir }) => {
    const exited = spawnSync(process.execPath, ['-e', '0']);
    expect(alive(exited.pid)).toBe(false);
    seedRunRoot(tempDir, 'mt-gone00', exited.pid);
    seedRunRoot(tempDir, 'mt-live00', process.pid);
    // A root another runner has just made and not yet written its owner into is kept;
    // one that has gone without an owner for over an hour is swept.
    seedRunRoot(tempDir, 'mt-fresh0', null);
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(seedRunRoot(tempDir, 'mt-stale0', null), hoursAgo, hoursAgo);

    const { status, output } = await runRunner(TEMP_LEAK_FIXTURE, {
      MYCO_RUNNER_TEMP_LEAK_FIXTURE: '1',
      MYCO_RUNNER_REPORT_DIR: reports,
      ...tempDirEnv(tempDir),
    });

    expect({ status, output }).toEqual({ status: 0, output: expect.stringContaining(' 1 pass') });
    expect(entries(tempDir)).toEqual(['mt-fresh0', 'mt-live00']);
    expect(output).toContain(`temp entries left in ${tempDir}: 0`);
  }), RUN_BOUND_MS + 10_000);

  test('a runner stopped by a signal ends the group it was running and removes its temp root', () => withRunDirs(async ({ reports, tempDir }) => {
    const readyFile = path.join(path.dirname(tempDir), 'fixture.pid');
    let runner: ChildProcess | undefined;
    const run = runRunner(TEMP_LEAK_FIXTURE, {
      MYCO_RUNNER_TEMP_LEAK_FIXTURE: '1',
      MYCO_RUNNER_TEMP_LEAK_READY_FILE: readyFile,
      MYCO_RUNNER_REPORT_DIR: reports,
      ...tempDirEnv(tempDir),
    }, [], (child) => { runner = child; });

    await waitFor(() => fs.existsSync(readyFile) && fs.readFileSync(readyFile, 'utf8').endsWith('\n'), 60_000, 'the fixture to leak and wait');
    const fixturePid = Number(fs.readFileSync(readyFile, 'utf8').trim());
    expect(entries(tempDir)).toEqual([expect.stringMatching(/^mt-[A-Za-z0-9]{6}$/)]);
    runner!.kill('SIGTERM');

    const { status } = await run;
    expect(status).toBe(128 + 15);
    await waitFor(() => !alive(fixturePid), 10_000, `fixture pid ${fixturePid} to exit`);
    expect(entries(tempDir)).toEqual([]);
  }), RUN_BOUND_MS + 10_000);

  test('a runner that dies of an uncaught error mid-group ends the group, puts the bunfig back and removes its temp root', () => withRunDirs(async ({ reports, tempDir }) => {
    const bunfig = path.join(REPO, 'bunfig.toml');
    const backup = path.join(REPO, '.bunfig.toml.runner-backup');
    const canonical = fs.readFileSync(bunfig, 'utf8');
    const readyFile = path.join(path.dirname(tempDir), 'fixture.pid');
    let runner: ChildProcess | undefined;
    let fixturePid: number | undefined;
    try {
      const run = runRunner(STREAM_FAULT_FIXTURE, {
        MYCO_RUNNER_STREAM_FAULT_FIXTURE: '1',
        MYCO_RUNNER_STREAM_FAULT_READY_FILE: readyFile,
        MYCO_RUNNER_REPORT_DIR: reports,
        ...tempDirEnv(tempDir),
      }, [], (child) => { runner = child; });

      await waitFor(() => fs.existsSync(readyFile) && fs.readFileSync(readyFile, 'utf8').endsWith('\n'), 60_000, 'the fixture to start writing');
      const pid = Number(fs.readFileSync(readyFile, 'utf8').trim());
      fixturePid = pid;
      expect(fs.readFileSync(bunfig, 'utf8')).not.toBe(canonical);
      // The runner's next write of the group's output fails: an EPIPE error event nothing handles.
      runner!.stdout!.destroy();

      const { status, output } = await run;
      expect({ status, output }).toEqual({ status: 1, output: expect.stringContaining('EPIPE') });
      await waitFor(() => !alive(pid), 10_000, `fixture pid ${pid} to exit`);
      expect({ bunfig: fs.readFileSync(bunfig, 'utf8'), backupLeft: fs.existsSync(backup) }).toEqual({ bunfig: canonical, backupLeft: false });
      expect(entries(tempDir)).toEqual([]);
    } finally {
      if (fs.existsSync(backup)) fs.renameSync(backup, bunfig);
      runner?.kill('SIGKILL');
      if (fixturePid !== undefined && alive(fixturePid)) process.kill(fixturePid, 'SIGKILL');
    }
  }), RUN_BOUND_MS + 10_000);

  test('real test files that leave temp directories behind leave nothing once the run ends', () => withRunDirs(async ({ reports, tempDir }) => {
    // Each of these leaves directories it made under os.tmpdir() (myco-run-, myco-stub-,
    // myco-member-home-, myco-auto-join-tx-, myco-member-machine-, myco-launchd-, myco-bin-, ...)
    // for the run to remove.
    const leakers = [
      'tests/member/worker-run-permissions.test.ts',
      'tests/member/provisioning.test.ts',
      'tests/member/auto-join.test.ts',
      'tests/cli/member-machine-verbs.test.ts',
      'tests/service/launchd.test.ts',
    ];
    const { status, output } = await runRunner(leakers[0]!, {
      MYCO_RUNNER_REPORT_DIR: reports,
      ...tempDirEnv(tempDir),
    }, leakers.slice(1));

    expect({ status, output }).toEqual({ status: 0, output: expect.stringMatching(/ 0 fail/) });
    expect(fs.readdirSync(tempDir)).toEqual([]);
  }), RUN_BOUND_MS + 10_000);

  test('a raw bun test run outside the runner removes the sandbox home its preload made', () => withRunDirs(async ({ reports, tempDir }) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
    const run = spawnSync('bun', ['test', `./${STDIN_FIXTURE}`], {
      cwd: REPO, env: { ...inherited, ...tempDirEnv(tempDir) }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
    });
    expect({ status: run.status, output: `${run.stdout}${run.stderr}` }).toEqual({ status: 0, output: expect.stringContaining(' 1 skip') });
    expect(entries(tempDir)).toEqual([]);
  }), RUN_BOUND_MS + 10_000);
});

describe('hang diagnostics redaction', () => {
  test('replaces every credential-like value, quoted or bare, and leaves the rest of a command line alone', () => {
    const cases: Array<[string, string]> = [
      ['bun test --token abc123 --api-key=XYZ', 'bun test --token <redacted> --api-key=<redacted>'],
      ['--token "two words" next', '--token <redacted> next'],
      ["--password='p w' rest", '--password=<redacted> rest'],
      ['MYCO_SECRET_TOKEN=s3cr3t x', 'MYCO_SECRET_TOKEN=<redacted> x'],
      ['Authorization: Bearer eyJhbGc', 'Authorization: Bearer <redacted>'],
      ['Authorization: Basic dXNlcjpwYXNz', 'Authorization: Basic <redacted>'],
      ['x-api-key: sk-123 more', 'x-api-key: <redacted> more'],
      ['{"token": "abc"}', '{"token": <redacted>}'],
      ['https://user:pw@host/x', 'https://<redacted>@host/x'],
      [`https://s/join#${'k'.repeat(43)}`, 'https://s/join#<redacted>'],
      ['bun test --timeout 30000 tests/a.test.ts', 'bun test --timeout 30000 tests/a.test.ts'],
    ];
    expect(cases.map(([input]) => [input, redactSecrets(input)])).toEqual(cases);
  });
});
