/**
 * Two guards of the test runner, each driven through the real runner:
 *   - a test group never reads the runner's stdin, so a test that reads fd 0
 *     finishes even when `npm test` was started with a stdin that never ends
 *     (a terminal, or an agent harness's socket);
 *   - a group still running at its wall-clock budget is sampled, killed with
 *     its whole process tree, and reported failed with its test files, and
 *     the run goes on.
 * The fixtures are skipped unless these tests set their flags.
 */
import { describe, expect, test } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HANG_FIXTURE = 'tests/fixtures/runner/budget_hang_test.ts';
const STDIN_FIXTURE = 'tests/fixtures/runner/stdin_read_test.ts';
const BUDGET_MS = 3000;
// Sampling takes a few seconds per process; anything near this bound means a guard did not fire.
const RUN_BOUND_MS = 90_000;

interface RunnerResult { status: number | null; output: string; elapsedMs: number }

/**
 * Run the runner on one target. Its stdin is a pipe this side never closes, as a harness's can be. The outer
 * run's own runner settings (a CI shard, a test kind, a plan file) are not passed on: the nested run is one group.
 */
function runRunner(target: string, env: Record<string, string>, args: string[] = []): Promise<RunnerResult> {
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^MYCO_(TEST|RUNNER)_/.test(key)));
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn('node', ['scripts/run-bun-tests.mjs', target, ...args], {
      cwd: REPO, env: { ...inherited, ...env }, stdio: ['pipe', 'pipe', 'pipe'],
    });
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
