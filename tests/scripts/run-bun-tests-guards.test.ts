/**
 * Two guards of the test runner, each driven through the real runner:
 *   - a test group never reads the runner's stdin, so a test that reads fd 0
 *     finishes even when `npm test` was started with a stdin that never ends
 *     (a terminal, or an agent harness's socket);
 *   - a group still running at its wall-clock budget is sampled, killed with
 *     its whole process tree, and reported failed with its test files, and
 *     the run goes on;
 *   - a run leaves nothing in the temp directory, whatever its tests leak and
 *     however it ends (at the end, by a signal, or of an uncaught error),
 *     and sweeps the roots of earlier runs
 *     whose runner is gone while keeping those of runs still going.
 * The fixtures are skipped unless these tests set their flags.
 */
import { describe, expect, test } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { redactSecrets } from '../../scripts/redact-secrets.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANG_FIXTURE = 'tests/fixtures/runner/budget_hang_test.ts';
const STDIN_FIXTURE = 'tests/fixtures/runner/stdin_read_test.ts';
const TEMP_LEAK_FIXTURE = 'tests/fixtures/runner/temp_leak_test.ts';
const TEMP_BOUNDARY_FIXTURE = 'tests/fixtures/runner/temp_boundary_test.ts';
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
  target: string | null,
  env: Record<string, string>,
  args: string[] = [],
  onSpawn: (runner: ChildProcess) => void = () => {},
): Promise<RunnerResult> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('node', ['scripts/run-bun-tests.mjs', ...(target ? [target] : []), ...args], {
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-reports-'));
  return fn(dir).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function reportFile(base: string, name: string): string {
  const runs = fs.readdirSync(base).filter((entry) => entry.startsWith('run-'));
  expect(runs).toHaveLength(1);
  return path.join(base, runs[0]!, name);
}

function fakeBun(base: string): string {
  const bin = path.join(base, 'bin');
  fs.mkdirSync(bin);
  const executable = path.join(bin, 'bun');
  fs.writeFileSync(executable, `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const args = process.argv.slice(2);
if (args[0] === '--version') {
  if (process.env.FAKE_BUN_ALTERNATE) {
    const link = path.join(process.env.HOME, 'bin', 'bun');
    fs.rmSync(link);
    fs.symlinkSync(process.env.FAKE_BUN_ALTERNATE, link);
  }
  console.log(process.env.FAKE_BUN_VERSION ?? '9.9.9');
  process.exit(0);
}
const preloads = args.flatMap((arg, index) => arg === '--preload' ? [args[index + 1]] : []);
console.log('FAKE_BUN_EXEC ' + process.argv[1] + ' PRELOADS ' + preloads.join(','));
const file = args.find((arg) => arg.startsWith('--reporter-outfile='))?.slice('--reporter-outfile='.length);
const mode = process.env.FAKE_BUN_MODE === 'fail-then-delay'
  ? (preloads.some((preload) => preload.includes('jsdom')) ? 'delayed-pass' : 'log-error')
  : (process.env.FAKE_BUN_MODE ?? 'pass');
if (mode === 'unreadable') fs.mkdirSync(file);
else if (mode !== 'missing') {
  const xml = mode === 'malformed' ? '<testsuites><testsuite'
    : mode === 'zero' ? '<testsuites><testsuite tests="0" failures="0" errors="0" /></testsuites>'
    : mode === 'skip-only' ? '<testsuites><testsuite tests="1" failures="0" errors="0"><testcase name="fixture"><skipped /></testcase></testsuite></testsuites>'
    : mode === 'junit-fail' ? '<testsuites><testsuite tests="1" failures="1" errors="0"><testcase name="fixture"><failure type="AssertionError" /></testcase></testsuite></testsuites>'
    : '<testsuites><testsuite tests="1" failures="0" errors="0"><testcase name="fixture" /></testsuite></testsuites>';
  fs.writeFileSync(file, xml);
}
if (mode === 'log-error') console.error(' 1 error');
else if (mode === 'fail-marker') console.error('(fail) fixture assertion');
else if (mode === 'uncaught-error') console.error('error: uncaught fixture');
else if (mode === 'colored-log-error') console.error(String.fromCharCode(27) + '[31m 1 error' + String.fromCharCode(27) + '[0m');
else if (mode === 'stream-only') {
  process.stderr.write(' 1 er');
  await new Promise((resolve) => setTimeout(resolve, 30));
  process.stderr.write('ror');
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(file.replace(/\\.junit\\.xml$/, '.log'), '');
}
else if (mode === 'held-tail-error') process.stderr.write(' 1 error');
else if (mode === 'skip-only') console.error(' 0 pass\\n 1 skip\\n 0 fail');
else console.error(' 1 pass\\n 0 fail');
if (mode === 'unreadable-log') {
  const log = file.replace(/\\.junit\\.xml$/, '.log');
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.rmSync(log, { force: true });
  fs.mkdirSync(log);
}
if (process.env.FAKE_BUN_READY_FILE && (process.env.FAKE_BUN_MODE !== 'fail-then-delay' || mode === 'delayed-pass')) fs.writeFileSync(process.env.FAKE_BUN_READY_FILE, String(process.pid));
if (process.env.FAKE_BUN_DELAY_MS && (process.env.FAKE_BUN_MODE !== 'fail-then-delay' || mode === 'delayed-pass')) await new Promise((resolve) => setTimeout(resolve, Number(process.env.FAKE_BUN_DELAY_MS)));
`);
  fs.chmodSync(executable, 0o755);
  const alternate = path.join(bin, 'other-bun');
  fs.writeFileSync(alternate, '#!/usr/bin/env node\nconsole.error("UNEXPECTED_BUN_PATH"); process.exit(67);\n');
  fs.chmodSync(alternate, 0o755);
  return bin;
}

describe('run-bun-tests guards', () => {
  test.skipIf(process.platform === 'win32')('mandatory log appends and live stream failures cannot produce a pass', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const preload = path.join(base, 'append-fault.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      const append = fs.appendFileSync;
      fs.appendFileSync = (file, data, ...rest) => {
        if (String(file).endsWith('.log') && (process.env.FAKE_LOG_FAULT === 'all'
            || (process.env.FAKE_LOG_FAULT === 'completion' && String(data).includes('[run-bun-tests] FINISHED')))) {
          const error = new Error('injected ENOSPC');
          error.code = 'ENOSPC';
          throw error;
        }
        return append(file, data, ...rest);
      };
      syncBuiltinESMExports();
    `);
    for (const [mode, fault, diagnostic] of [
      ['pass', 'all', 'cannot append mandatory log'],
      ['log-error', 'all', 'cannot append mandatory log'],
      ['pass', 'completion', 'cannot append mandatory log'],
      ['stream-only', '', 'stream reported a failure or error'],
    ]) {
      const reports = path.join(base, `${mode}-${fault || 'stream'}`);
      const { status, output } = await runRunner(STDIN_FIXTURE, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        MYCO_RUNNER_REPORT_DIR: reports,
        FAKE_BUN_MODE: mode,
        FAKE_LOG_FAULT: fault,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${preload}`.trim(),
      });
      expect({ mode, fault, status, output }).toEqual({ mode, fault, status: 1, output: expect.stringContaining(diagnostic) });
    }
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('accepts evidence only when Bun ran tests and both artifacts are readable', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const cases: Array<[string, string]> = [
      ['missing', 'ENOENT'],
      ['unreadable', 'EISDIR'],
      ['malformed', 'unclosed tag'],
      ['zero', 'zero executed tests'],
      ['junit-fail', 'JUnit aggregated 1 failure'],
      ['log-error', 'Bun reported a failure or error'],
      ['fail-marker', 'Bun reported a failure or error'],
      ['uncaught-error', 'Bun reported a failure or error'],
      ['colored-log-error', 'Bun reported a failure or error'],
      ['unreadable-log', 'EISDIR'],
    ];
    for (const [mode, diagnostic] of cases) {
      const reports = path.join(base, mode);
      const { status, output } = await runRunner(STDIN_FIXTURE, {
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        MYCO_RUNNER_REPORT_DIR: reports,
        FAKE_BUN_MODE: mode,
      });
      expect({ mode, status, output }).toEqual({ mode, status: 1, output: expect.stringContaining(diagnostic) });
    }
    const { status, output } = await runRunner(STDIN_FIXTURE, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: path.join(base, 'pass'),
    });
    expect(status).toBe(0);
    expect(output).toContain('FAKE_BUN_EXEC');
    expect(output).toContain('PRELOADS ./tests/setup/sandbox-preload.ts');
    expect(output).toContain('WARNING: running Bun 9.9.9');
    const skipped = await runRunner(STDIN_FIXTURE, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: path.join(base, 'skip-only'),
      FAKE_BUN_MODE: 'skip-only',
    });
    expect(skipped.status).toBe(0);
    const matching = await runRunner(STDIN_FIXTURE, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: path.join(base, 'matching'),
      FAKE_BUN_VERSION: fs.readFileSync(path.join(REPO, '.bun-version'), 'utf8').trim(),
    });
    expect(matching.status).toBe(0);
    expect(matching.output).not.toContain('WARNING: running Bun');
    const pinned = await runRunner(STDIN_FIXTURE, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: path.join(base, 'pinned-executable'),
      FAKE_BUN_ALTERNATE: path.join(bin, 'other-bun'),
    });
    expect(pinned.status).toBe(0);
    expect(pinned.output).toContain('FAKE_BUN_EXEC');
    expect(pinned.output).not.toContain('UNEXPECTED_BUN_PATH');
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('concurrent runs keep configs and reports separate when one is interrupted', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const reports = path.join(base, 'shared-reports');
    const canonical = fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8');
    const ready = path.join(base, 'first-ready');
    let firstChild: ChildProcess | undefined;
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_RUNNER_REPORT_DIR: reports, FAKE_BUN_DELAY_MS: '1500' };
    const first = runRunner(STDIN_FIXTURE, { ...env, FAKE_BUN_READY_FILE: ready }, [], (child) => { firstChild = child; });
    await waitFor(() => fs.existsSync(ready), 30_000, 'first fake Bun phase');
    const second = runRunner(STREAM_FAULT_FIXTURE, env);
    expect(fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8')).toBe(canonical);
    firstChild!.kill('SIGTERM');
    const [interrupted, completed] = await Promise.all([first, second]);
    expect(interrupted.status).toBe(143);
    expect(completed.status).toBe(0);
    expect(completed.output).toContain('PRELOADS ./tests/setup/jsdom.ts,./tests/setup/sandbox-preload.ts');
    expect(fs.readdirSync(reports).filter((entry) => entry.startsWith('run-'))).toHaveLength(2);
    expect(fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8')).toBe(canonical);
    expect(fs.existsSync(path.join(REPO, '.bunfig.toml.runner-backup'))).toBe(false);
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('report retention bounds success and interruption while preserving failures, live owners, and unknown directories', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const reports = path.join(base, 'reports');
    const env = { PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_RUNNER_REPORT_DIR: reports };
    const run = (mode = 'pass') => runRunner(STDIN_FIXTURE, { ...env, FAKE_BUN_MODE: mode });
    const directories = () => fs.readdirSync(reports).filter((name) => name.startsWith('run-')).map((name) => path.join(reports, name));
    const statusOf = (dir: string) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, '.runner-outcome.json'), 'utf8')).status as string; }
      catch { return 'abandoned'; }
    };
    const statusCounts = () => directories().map(statusOf);
    expect((await run('log-error')).status).toBe(1);
    const failed = directories().find((dir) => statusOf(dir) === 'failed')!;
    const unknown = path.join(reports, 'run-abcdef');
    fs.mkdirSync(unknown);
    for (let index = 0; index < 5; index += 1) expect((await run()).status).toBe(0);
    expect(statusCounts().filter((status) => status === 'success')).toHaveLength(3);
    expect(fs.existsSync(failed)).toBe(true);
    expect(fs.existsSync(unknown)).toBe(true);

    for (let index = 0; index < 4; index += 1) {
      const ready = path.join(base, `interrupt-${index}.ready`);
      let runner: ChildProcess | undefined;
      const pending = runRunner(STDIN_FIXTURE, { ...env, FAKE_BUN_READY_FILE: ready, FAKE_BUN_DELAY_MS: '10000' }, [], (child) => { runner = child; });
      await waitFor(() => fs.existsSync(ready), 30_000, 'fake Bun phase before interrupt');
      runner!.kill(index === 0 ? 'SIGKILL' : 'SIGTERM');
      const result = await pending;
      expect(result.status).not.toBe(0);
    }
    expect(directories().filter((dir) => dir !== unknown).map(statusOf).filter((status) => status === 'interrupted' || status === 'abandoned')).toHaveLength(2);

    const ready = path.join(base, 'live.ready');
    let liveRunner: ChildProcess | undefined;
    const live = runRunner(STDIN_FIXTURE, { ...env, FAKE_BUN_READY_FILE: ready, FAKE_BUN_DELAY_MS: '10000' }, [], (child) => { liveRunner = child; });
    try {
      await waitFor(() => fs.existsSync(ready), 30_000, 'live fake Bun phase');
      const liveDir = directories().find((dir) => {
        try { return JSON.parse(fs.readFileSync(path.join(dir, '.runner-owner.json'), 'utf8')).pid === liveRunner!.pid; }
        catch { return false; }
      });
      expect(liveDir).toBeTruthy();
      expect((await run()).status).toBe(0);
      expect(fs.existsSync(liveDir!)).toBe(true);
      expect(fs.existsSync(failed)).toBe(true);
      expect(fs.existsSync(unknown)).toBe(true);
    } finally {
      liveRunner?.kill('SIGTERM');
      await live;
    }
  }), RUN_BOUND_MS * 2);

  test.skipIf(process.platform === 'win32')('a failed phase remains a failed report when a later phase is interrupted', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const reports = path.join(base, 'reports');
    const ready = path.join(base, 'dom.ready');
    let runner: ChildProcess | undefined;
    const pending = runRunner(null, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: reports,
      FAKE_BUN_MODE: 'fail-then-delay',
      FAKE_BUN_READY_FILE: ready,
      FAKE_BUN_DELAY_MS: '10000',
    }, [STDIN_FIXTURE, STREAM_FAULT_FIXTURE], (child) => { runner = child; });
    try {
      await waitFor(() => fs.existsSync(ready), 30_000, 'DOM phase after failed node phase');
      runner!.kill('SIGTERM');
      const result = await pending;
      expect(result.status).toBe(143);
      const dir = fs.readdirSync(reports).find((name) => name.startsWith('run-'))!;
      expect(JSON.parse(fs.readFileSync(path.join(reports, dir, '.runner-outcome.json'), 'utf8')).status).toBe('failed');
    } finally {
      if (runner && alive(runner.pid!)) runner.kill('SIGKILL');
    }
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('an unterminated failure line remains failed when its active phase is interrupted', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const reports = path.join(base, 'reports');
    const ready = path.join(base, 'child.ready');
    let runner: ChildProcess | undefined;
    const pending = runRunner(STDIN_FIXTURE, {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      MYCO_RUNNER_REPORT_DIR: reports,
      FAKE_BUN_MODE: 'held-tail-error',
      FAKE_BUN_READY_FILE: ready,
      FAKE_BUN_DELAY_MS: '10000',
    }, [], (child) => { runner = child; });
    try {
      await waitFor(() => fs.existsSync(ready), 30_000, 'unterminated error before interrupt');
      await waitFor(() => fs.readdirSync(reports).some((name) => {
        if (!name.startsWith('run-')) return false;
        const log = path.join(reports, name, 'node-env.log');
        return fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes(' 1 error');
      }), 30_000, 'runner to ingest the unterminated error');
      runner!.kill('SIGTERM');
      const result = await pending;
      expect(result.status).toBe(143);
      const dir = fs.readdirSync(reports).find((name) => name.startsWith('run-'))!;
      expect(JSON.parse(fs.readFileSync(path.join(reports, dir, '.runner-outcome.json'), 'utf8')).status).toBe('failed');
    } finally {
      if (runner && alive(runner.pid!)) runner.kill('SIGKILL');
    }
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('malformed and unreadable report metadata is preserved with safe diagnostics', () => withReportDir(async (base) => {
    const bin = fakeBun(base);
    const reports = path.join(base, 'reports');
    fs.mkdirSync(reports);
    const deadPid = spawnSync(process.execPath, ['-e', ''], { encoding: 'utf8' }).pid!;
    expect(alive(deadPid)).toBe(false);
    const malformedOwner = path.join(reports, 'run-aaaaaa');
    const unreadableOwner = path.join(reports, 'run-bbbbbb');
    const malformedOutcome = path.join(reports, 'run-cccccc');
    for (const dir of [malformedOwner, unreadableOwner, malformedOutcome]) fs.mkdirSync(dir);
    fs.writeFileSync(path.join(malformedOwner, '.runner-owner.json'), '{secret: credential-value');
    fs.mkdirSync(path.join(unreadableOwner, '.runner-owner.json'));
    fs.writeFileSync(path.join(malformedOutcome, '.runner-owner.json'), JSON.stringify({ pid: deadPid, createdAt: Date.now() - 1000 }));
    fs.writeFileSync(path.join(malformedOutcome, '.runner-outcome.json'), '{secret: credential-value');
    const result = await runRunner(STDIN_FIXTURE, { PATH: `${bin}${path.delimiter}${process.env.PATH}`, MYCO_RUNNER_REPORT_DIR: reports });
    expect(result.status).toBe(0);
    expect(result.output).toContain('owner invalid JSON');
    expect(result.output).toContain('owner EISDIR');
    expect(result.output).toContain('outcome invalid JSON');
    expect(result.output).not.toContain('credential-value');
    for (const dir of [malformedOwner, unreadableOwner, malformedOutcome]) expect(fs.existsSync(dir)).toBe(true);
  }), RUN_BOUND_MS + 10_000);

  test('real overlapping node and DOM phases each load their own preloads', () => withReportDir(async (base) => {
    const reports = path.join(base, 'reports');
    const ready = path.join(base, 'ready');
    fs.mkdirSync(ready);
    const canonical = fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8');
    const env = { MYCO_RUNNER_REPORT_DIR: reports, MYCO_RUNNER_CONFIG_READY_DIR: ready };
    const [node, dom] = await Promise.all([
      runRunner('tests/fixtures/runner/node_config_isolation_test.ts', env),
      runRunner('tests/fixtures/runner/dom_config_isolation_test.tsx', env),
    ]);
    expect({ node: node.status, dom: dom.status, nodeOutput: node.output, domOutput: dom.output }).toEqual({
      node: 0, dom: 0,
      nodeOutput: expect.stringContaining(' 1 pass'),
      domOutput: expect.stringContaining(' 1 pass'),
    });
    expect(fs.readdirSync(reports).filter((entry) => entry.startsWith('run-'))).toHaveLength(2);
    expect(fs.readFileSync(path.join(REPO, 'bunfig.toml'), 'utf8')).toBe(canonical);
  }), RUN_BOUND_MS + 10_000);

  test('concurrent bundle plans use different generated paths', () => withReportDir(async (base) => {
    const env = { MYCO_RUNNER_DRY_RUN: '1', MYCO_TEST_KIND: 'node', MYCO_TEST_PROFILE: 'fast', MYCO_RUNNER_REPORT_DIR: path.join(base, 'reports') };
    const [first, second] = await Promise.all([
      runRunner(null, env),
      runRunner(null, env),
    ]);
    expect([first.status, second.status]).toEqual([0, 0]);
    const bundlePath = (output: string) => output.match(/target\/test-bundles\/node-env-mt-[^;\s]+/)?.[0];
    expect(bundlePath(first.output)).toBeTruthy();
    expect(bundlePath(second.output)).toBeTruthy();
    expect(bundlePath(first.output)).not.toBe(bundlePath(second.output));
  }), RUN_BOUND_MS + 10_000);

  test.skipIf(process.platform === 'win32')('ends fixture children when writing their PID receipt fails', () => withReportDir(async (reports) => {
    let pids: number[] = [];
    try {
      const { status, output } = await runRunner(HANG_FIXTURE, {
        MYCO_RUNNER_HANG_FIXTURE: '1', MYCO_RUNNER_REPORT_DIR: reports,
        MYCO_RUNNER_HANG_PIDS_FILE: path.join(reports, 'missing', 'children.pids'),
      }, ['-t', 'blocks']);
      pids = output.match(/FIXTURE_CHILD_PIDS (\d+) (\d+)/)!.slice(1).map(Number);
      expect(status).toBe(1);
      expect(output).toContain('ENOENT');
      await waitFor(() => pids.every((pid) => !alive(pid)), 5000, 'the failed fixture children to exit');
    } finally {
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }), RUN_BOUND_MS + 10_000);

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

    const junit = fs.readFileSync(reportFile(reports, 'node-env.junit.xml'), 'utf8');
    expect(junit).toContain(`file="${HANG_FIXTURE}"`);
    expect(junit).toContain('<failure type="GroupBudgetExceeded"');

    const hang = fs.readFileSync(reportFile(reports, 'node-env.hang.txt'), 'utf8');
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
  test.skipIf(process.platform === 'win32')('stops an unrefed child after a passing phase before removing its root', () => withRunDirs(async ({ reports, tempDir }) => {
    const ready = path.join(path.dirname(tempDir), 'settled-child.pid');
    let pid: number | undefined;
    try {
      const result = await runRunner('tests/fixtures/runner/settled_child_test.ts', {
        MYCO_RUNNER_SETTLED_CHILD_FILE: ready, MYCO_RUNNER_REPORT_DIR: reports, ...tempDirEnv(tempDir),
      });
      pid = Number(fs.readFileSync(ready, 'utf8'));
      expect({ status: result.status, output: result.output }).toEqual({ status: 0, output: expect.stringContaining(' 1 pass') });
      await waitFor(() => !alive(pid!), 5000, 'the settled phase child to exit');
      expect(entries(tempDir)).toEqual([]);
    } finally {
      if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    }
  }), RUN_BOUND_MS + 10_000);
  test('surfaces a process-tree cleanup error after a passing Bun phase', () => withRunDirs(async ({ reports, tempDir }) => {
    const preload = path.join(path.dirname(tempDir), 'windows-cleanup-fault.mjs');
    fs.writeFileSync(preload, `
      import cp from 'node:child_process';
      import { syncBuiltinESMExports } from 'node:module';
      const original = cp.spawnSync;
      Object.defineProperty(process, 'platform', { value: 'win32' });
      process.kill = () => true;
      cp.spawnSync = (command, args, options) => {
        if (args.includes('-NonInteractive')) return args.at(-1).includes('.Kill(')
          ? { status: 5, stdout: '', stderr: 'fixture Bun cleanup refused' }
          : { status: 0, stdout: '123456', stderr: '' };
        return original(command, args, options);
      };
      syncBuiltinESMExports();
    `);
    const result = spawnSync('node', ['--import', pathToFileURL(preload).href, 'scripts/run-bun-tests.mjs', STDIN_FIXTURE], {
      env: { ...process.env, ...tempDirEnv(tempDir), MYCO_RUNNER_REPORT_DIR: reports, MYCO_TEST_SHARD: '1/1', MYCO_TEST_KIND: 'all' }, encoding: 'utf8',
    });
    expect({ status: result.status, output: result.stderr }).toEqual({ status: 1, output: expect.stringContaining('fixture Bun cleanup refused') });
    expect(result.stderr).toContain(' 0 fail');
    expect(entries(tempDir)).toEqual([]);
  }), RUN_BOUND_MS + 10_000);
  for (const target of [TEMP_BOUNDARY_FIXTURE, 'tests/fixtures/runner/temp_dom_boundary_test.tsx']) {
    test(`contains module-load and subprocess temp paths through ${target}`, () => withRunDirs(async ({ reports, tempDir }) => {
      const result = await runRunner(target, {
        MYCO_RUNNER_TEMP_BOUNDARY_FIXTURE: '1', MYCO_RUNNER_REPORT_DIR: reports, ...tempDirEnv(tempDir),
      });
      expect({ status: result.status, output: result.output }).toEqual({ status: 0, output: expect.stringContaining(' 0 fail') });
      expect(entries(tempDir)).toEqual([]);
    }), RUN_BOUND_MS + 10_000);
  }

  test('fails a passing test phase when new myco-* or mt-* entries escape, preserving old and escaped entries', () => withRunDirs(async ({ reports, tempDir }) => {
    fs.writeFileSync(path.join(tempDir, 'myco-preexisting'), 'retain');
    const result = await runRunner(TEMP_BOUNDARY_FIXTURE, {
      MYCO_TEST_STRICT_TEMP: '1', MYCO_RUNNER_TEMP_BOUNDARY_FIXTURE: '1', MYCO_RUNNER_ESCAPE_FIXTURE: '1', MYCO_RUNNER_REPORT_DIR: reports, ...tempDirEnv(tempDir),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain('FAIL: new test temp entries outside');
    expect(result.output).toContain(' 0 fail');
    expect(result.output).toContain(`temp entries left in ${tempDir}: 2`);
    expect(entries(tempDir).sort()).toEqual([expect.stringMatching(/^mt-escaped-/), expect.stringMatching(/^myco-escaped-/), 'myco-preexisting']);
  }), RUN_BOUND_MS + 10_000);

  test('a run leaves nothing in the temp directory, and sweeps only the roots of runners that are gone', () => withRunDirs(async ({ reports, tempDir }) => {
    const exited = spawnSync(process.execPath, ['-e', '0']);
    expect(alive(exited.pid)).toBe(false);
    seedRunRoot(tempDir, 'mt-gone00', exited.pid);
    seedRunRoot(tempDir, 'mt-live00', process.pid);
    // Roots with no owner record have unknown ownership at any age.
    seedRunRoot(tempDir, 'mt-fresh0', null);
    const hoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    fs.utimesSync(seedRunRoot(tempDir, 'mt-stale0', null), hoursAgo, hoursAgo);

    const { status, output } = await runRunner(TEMP_LEAK_FIXTURE, {
      MYCO_RUNNER_TEMP_LEAK_FIXTURE: '1',
      MYCO_RUNNER_REPORT_DIR: reports,
      ...tempDirEnv(tempDir),
    });

    expect({ status, output }).toEqual({ status: 0, output: expect.stringContaining(' 1 pass') });
    expect(entries(tempDir)).toEqual(['mt-fresh0', 'mt-live00', 'mt-stale0']);
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

  test('a runner that dies of an uncaught error mid-group ends the group and leaves the checkout config intact', () => withRunDirs(async ({ reports, tempDir }) => {
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
      expect(fs.readFileSync(bunfig, 'utf8')).toBe(canonical);
      expect(fs.existsSync(backup)).toBe(false);
      // The runner's next write of the group's output fails: an EPIPE error event nothing handles.
      runner!.stdout!.destroy();

      const { status, output } = await run;
      expect({ status, output }).toEqual({ status: 1, output: expect.stringContaining('EPIPE') });
      await waitFor(() => !alive(pid), 10_000, `fixture pid ${pid} to exit`);
      expect({ bunfig: fs.readFileSync(bunfig, 'utf8'), backupLeft: fs.existsSync(backup) }).toEqual({ bunfig: canonical, backupLeft: false });
      expect(entries(tempDir)).toEqual([]);
    } finally {
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

  test('a raw bun test run outside the runner removes the sandbox home its preload made and the homes test helpers made', () => withRunDirs(async ({ tempDir }) => {
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
    // tempMycoHome() and tempStager() (tests/member/helpers/server.ts) from a beforeAll, a beforeEach and a test body.
    const files = [`./${STDIN_FIXTURE}`, `./${TEMP_BOUNDARY_FIXTURE}`, './tests/member/envelope.test.ts', './tests/member/machine-settings.test.ts', './tests/member/diagnostic-private-link.test.ts'];
    for (const isolation of [[], ['--isolate']]) {
      const run = spawnSync('bun', ['test', ...isolation, ...files], {
        cwd: REPO, env: { ...inherited, ...tempDirEnv(tempDir), MYCO_RUNNER_TEMP_BOUNDARY_FIXTURE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
      });
      expect({ isolation, status: run.status, output: `${run.stdout}${run.stderr}` }).toEqual({ isolation, status: 0, output: expect.stringMatching(/ 0 fail/) });
      expect({ isolation, left: entries(tempDir) }).toEqual({ isolation, left: [] });
    }
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
