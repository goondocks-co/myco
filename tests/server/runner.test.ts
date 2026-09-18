/**
 * What a failed command tells the operator. A `--json` command names its
 * failure on stdout while its configuration warnings fill stderr, so the
 * message a refusal carries has to be built from both streams rather than from
 * stderr alone.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CommandCancelled, CommandFailed, commandFailureDetail, CommandTimedOut, isCommandFailure, processTreeEndOfSignal,
  processTreeEndOfTaskkill, systemRunner, WorkingDirectoryMissing,
} from '@myco/server/runner.js';

const failed = (stdout: string, stderr: string, code = 1): CommandFailed =>
  new CommandFailed('npx', ['wrangler', 'd1', 'execute', 'myco-server'], { code, stdout, stderr });

/** A wrangler configuration warning, as it reaches stderr around a failure. */
const WARNING = [
  '',
  '\u001b[33m\u25b2 \u001b[43;33m[\u001b[43;30mWARNING\u001b[43;33m]\u001b[0m Processing wrangler.deploy.toml configuration:',
  '',
  '    - Unexpected fields found in top-level field: "unstable_dev"',
  '',
  '',
].join('\n');

describe('a failed command names what it printed', () => {
  it('reads the JSON error document wrangler writes to stdout, with each note it carries', () => {
    const document = JSON.stringify({
      error: {
        text: 'A request to the Cloudflare API (/accounts/a/d1/database/b/query) failed.',
        notes: [{ text: 'internal error; reference = 7f3c1d2e' }, { text: '' }],
        kind: 'error',
        name: 'APIError',
        code: 7400,
      },
    });
    const err = failed(`${WARNING}${document}\n`, WARNING);

    expect(err.message).toContain('A request to the Cloudflare API');
    expect(err.message).toContain('internal error; reference = 7f3c1d2e');
    expect(err.message).toContain('exited 1');
    expect(err.message).not.toContain('Unexpected fields');
    expect({ stdout: err.stdout.includes(document), stderr: err.stderr }).toEqual({ stdout: true, stderr: WARNING });
  });

  it('GATE: a stderr that holds only a configuration warning does not become the message', () => {
    const err = failed('\u2718 the D1 database myco-server could not be reached\n', `${WARNING}\u001b[31m\u2718 [ERROR] npx exited with 1\u001b[0m\n`);

    expect(err.message).toContain('the D1 database myco-server could not be reached');
    expect(err.message).toContain('npx exited with 1');
    expect(err.message).not.toContain('Unexpected fields');
    expect(err.message).not.toContain('Processing wrangler.deploy.toml');
  });

  it('carries both streams when neither holds a JSON document, npm notices dropped and the tail bounded', () => {
    const stdout = ['npm notice run npx', ...Array.from({ length: 20 }, (_, at) => `line ${at}`)].join('\n');
    const detail = commandFailureDetail({ code: 1, stdout, stderr: 'docker daemon unreachable\n' });

    expect(detail.split('\n')).toEqual(['line 14', 'line 15', 'line 16', 'line 17', 'line 18', 'line 19', 'docker daemon unreachable']);
    expect(detail).not.toContain('npm notice');
    expect(commandFailureDetail({ code: 1, stdout: 'x'.repeat(4000), stderr: '' }).length).toBe(1000);
  });

  it('GATE: never drops everything — output that is all noise is carried raw', () => {
    const err = failed('', WARNING);
    expect(err.message).toContain('Unexpected fields found in top-level field');
  });
});

/**
 * Where a command is asked to run, when it is asked to run somewhere that does
 * not exist.
 */
describe('a command pointed at a directory that is not there', () => {
  it('GATE: names the directory rather than the command, which is on the PATH', async () => {
    const absent = join(tmpdir(), 'myco-runner-absent', 'never-created');
    const refused = await systemRunner().run('npx', ['--version'], { cwd: absent }).catch((err: unknown) => err as Error);

    expect(refused).toBeInstanceOf(WorkingDirectoryMissing);
    if (!(refused instanceof Error)) throw new Error('the run resolved instead of refusing');
    // The platform reports this as ENOENT against `npx`, which sends whoever
    // reads it hunting for a program that is installed.
    expect(refused.message).toContain(absent);
    expect(refused.message).not.toContain('posix_spawn');
    expect(refused.message).not.toContain('no such file or directory, ');
  });
});

/**
 * A deadline ends what the command started, not just the command.
 *
 * The launcher pattern this path actually uses is `npx <tool>`: the tool is a child of its own launcher, it inherits
 * the pipes, and it is the thing sending statements. A deadline that signals only the launcher leaves that tool
 * running — free to write after the deadline — and `close` then waits for it to let the pipes go, so the caller waits
 * for the very process the deadline was meant to end.
 */
describe('a command that outran its deadline', () => {
  it('GATE: ends the processes it started, and answers at its deadline rather than waiting for their pipes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-runner-deadline-'));
    try {
      const marker = join(root, 'late-write');
      const pidFile = join(root, 'child.pid');
      // A launcher whose child writes well after a 300 ms deadline, then outlives it. The write is 2.5 s out
      // because ending a tree is not instantaneous everywhere: a process group goes at once, `taskkill` is a
      // process of its own that has to run. The gap has to be larger than the slowest of those, or the test
      // would be reporting the platform's cleanup latency as a defect.
      const grandchild = `require('fs').writeFileSync(${JSON.stringify(pidFile)},String(process.pid));`
        + `setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'wrote after the deadline'),2500);`
        + 'setTimeout(()=>process.exit(0),4000);';
      const launcher = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});`
        + 'setTimeout(()=>{},5000);';
      const started = Date.now();
      const refused = await systemRunner().run(process.execPath, ['-e', launcher], { timeoutMs: 300 })
        .catch((err: unknown) => err as Error);
      const elapsed = Date.now() - started;

      expect(refused).toBeInstanceOf(CommandTimedOut);
      // What it says about the tree is what ending it actually answered, and here that is success.
      expect((refused as CommandTimedOut).treeEnd).toBe('ended');
      expect((refused as CommandTimedOut).message).toContain('the processes it started were ended');
      // The call answers at its own deadline, not once the tree's pipes close — which is what made a 300 ms
      // deadline answer after 1664 ms. Windows spends its own bounded run on `taskkill` before answering.
      expect(elapsed).toBeLessThan(process.platform === 'win32' ? 2000 : 900);
      // Past the moment that write was due: it must never arrive.
      await Bun.sleep(Math.max(0, 3200 - (Date.now() - started)));
      expect(existsSync(marker)).toBe(false);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      const alive = (): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
      expect(alive()).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // POSIX only: `ps -o pgid=` and process groups are what this asserts, and Windows has neither. The deadline
  // test above is the portable one, and on Windows it exercises the `taskkill` path instead.
  it.skipIf(process.platform === 'win32')('GATE: gives only a bounded command a group of its own, so an unbounded one still ends with this process', async () => {
    // `$$` is the shell's own pid, and `ps` answers the group it belongs to.
    const groupOf = async (options: { timeoutMs?: number }): Promise<string> =>
      (await systemRunner().run('/bin/sh', ['-c', 'ps -o pgid= -p $$'], options)).stdout.trim();
    const mine = (await systemRunner().run('/bin/sh', ['-c', `ps -o pgid= -p ${process.pid}`], {})).stdout.trim();

    // An unbounded command shares this process's group: the terminal that ends this one ends it too.
    expect(await groupOf({})).toBe(mine);
    // A bounded one leads its own, which is the only thing a deadline can signal without signalling this process.
    expect(await groupOf({ timeoutMs: 30_000 })).not.toBe(mine);
  });
});

/**
 * What a failed cleanup is allowed to claim.
 *
 * Ending a tree can be refused — `taskkill` exits non-zero on an access denial, a group signal comes back
 * `EPERM` — and it can answer nothing at all. A caller that is told "ended" then treats a live process as gone,
 * which is exactly the shape a fire-and-forget killer produced: the call said the processes were ended at 204 ms
 * and one of them wrote at 800 ms. These are the classifications the platform branches read, so they are
 * asserted on every platform rather than only on the one that runs them.
 */
describe('what ending a process tree answers', () => {
  it('GATE: calls a refused tree-killer a failure, and only "not found" settled', () => {
    expect(processTreeEndOfTaskkill({ code: 0 })).toBe('ended');
    // taskkill's own "process not found", about the PID it was given: the wrapper may have exited while a
    // descendant still runs, so nothing here proves the tree gone.
    expect(processTreeEndOfTaskkill({ code: 128 })).toBe('unknown');
    // An access denial. The tree is still running, and this must never read as ended or already gone.
    expect(processTreeEndOfTaskkill({ code: 1 })).toBe('failed');
    expect(processTreeEndOfTaskkill({ code: null })).toBe('failed');
    // It could not be started, or it did not answer inside its own window: nothing is known about the tree.
    expect(processTreeEndOfTaskkill({ error: new Error('spawn taskkill ENOENT') })).toBe('unknown');
    expect(processTreeEndOfTaskkill({ code: 0, timedOut: true })).toBe('unknown');
  });

  it('GATE: calls only ESRCH already gone, so a signal this process may not send is not mistaken for one', () => {
    expect(processTreeEndOfSignal(Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' }))).toBe('absent');
    expect(processTreeEndOfSignal(Object.assign(new Error('kill EPERM'), { code: 'EPERM' }))).toBe('failed');
    expect(processTreeEndOfSignal(new Error('something else entirely'))).toBe('failed');
    expect(processTreeEndOfSignal(null)).toBe('failed');
  });

  it('says what it could not do, rather than reporting a tree it never ended as ended', () => {
    const failed = new CommandTimedOut('npx', ['wrangler', 'd1', 'execute'], 60_000, 'failed');
    expect(failed.message).toContain('could NOT be ended and may still be running');
    expect(new CommandTimedOut('npx', [], 60_000, 'unknown').message).toContain('is unknown');
    expect(new CommandTimedOut('npx', [], 60_000, 'absent').message).toContain('already gone');
    // A caller that names no outcome gets the honest one, not a claim of success.
    expect(new CommandTimedOut('npx', [], 60_000).treeEnd).toBe('unknown');
  });
});

/**
 * The same refusals, through the runner's own signalling rather than the classifiers alone.
 *
 * `process.kill` IS the seam the POSIX branch ends a tree with, so these replace it for the length of one
 * deadline and read what the caller is told. Each one then ends the real tree itself, so nothing is left behind.
 */
describe.skipIf(process.platform === 'win32')('a deadline whose group signal is refused', () => {
  /** A launcher that records its own pid and its child's, and keeps both alive well past any deadline here. */
  const launcher = (root: string): { argv: string[]; pids: () => number[] } => {
    const leaderFile = join(root, 'leader.pid');
    const childFile = join(root, 'child.pid');
    const grandchild = `require('fs').writeFileSync(${JSON.stringify(childFile)},String(process.pid));`
      + 'setTimeout(()=>process.exit(0),4000);';
    const code = `require('fs').writeFileSync(${JSON.stringify(leaderFile)},String(process.pid));`
      + `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});`
      + 'setTimeout(()=>{},4000);';
    return {
      argv: ['-e', code],
      pids: () => [leaderFile, childFile].filter((f) => existsSync(f)).map((f) => Number(readFileSync(f, 'utf8'))),
    };
  };

  /** Runs one bounded command with `process.kill` replaced, and ends whatever it left running. */
  const withSignal = async (
    kill: (real: typeof process.kill, pid: number, signal?: string | number) => boolean,
  ): Promise<CommandTimedOut> => {
    const root = mkdtempSync(join(tmpdir(), 'myco-runner-signal-'));
    const real = process.kill.bind(process);
    const spawned = launcher(root);
    try {
      process.kill = ((pid: number, signal?: string | number) => kill(real, pid, signal)) as typeof process.kill;
      const refused = await systemRunner().run(process.execPath, spawned.argv, { timeoutMs: 300 })
        .catch((err: unknown) => err as Error);
      if (!(refused instanceof CommandTimedOut)) throw new Error(`the run did not time out: ${String(refused)}`);
      return refused;
    } finally {
      process.kill = real;
      // The tree really is still running — that is the point of the test — so end it for real.
      for (const pid of spawned.pids()) { try { real(pid, 'SIGKILL'); } catch { /* already gone */ } }
      rmSync(root, { recursive: true, force: true });
    }
  };

  it('GATE: reports a tree it could not end, and never repairs it by ending the leader', async () => {
    // The group signal is denied; the leader itself would still take one. Ending the leader would leave every
    // process it started running, so it cannot make this cleanup a success.
    const refused = await withSignal((real, pid, signal) => {
      if (pid < 0) throw Object.assign(new Error('kill EPERM'), { code: 'EPERM' });
      return real(pid, signal as NodeJS.Signals);
    });

    expect(refused.treeEnd).toBe('failed');
    expect(refused.message).toContain('could NOT be ended and may still be running');
  });

  it('GATE: does not call a tree gone on "no such group" while its leader is still running', async () => {
    // What an ungrouped process answers: there is no group of that id, and the command is very much alive.
    const refused = await withSignal((real, pid, signal) => {
      if (pid < 0) throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      return real(pid, signal as NodeJS.Signals);
    });

    expect(refused.treeEnd).toBe('failed');
  });
});

/**
 * Withdrawal: a caller that owns a long command needs to be able to stop owning it.
 *
 * What the deadline already does, a caller may now ask for, and it answers the same way: the command and the
 * processes it started are ended, and what that managed is reported rather than assumed.
 */
describe('a withdrawn command', () => {
  /**
   * A launcher whose child keeps writing, so ending the command has to end a tree rather than one process.
   *
   * Both are this runtime, started the way the deadline fixtures above start theirs: every platform in this
   * project runs the same executable, and a shell is not one of them.
   */
  const writing = (root: string): { argv: string[]; marker: string } => {
    const marker = join(root, 'alive');
    const grandchild = `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'.'),50);`
      + 'setTimeout(()=>process.exit(0),8000);';
    const code = `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});`
      + 'setTimeout(()=>{},8000);';
    return { argv: ['-e', code], marker };
  };

  it('ends the command and what it started, and says what that ended', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-runner-withdraw-'));
    const withdrawing = new AbortController();
    try {
      const child = writing(root);
      const running = systemRunner().run(process.execPath, child.argv, { signal: withdrawing.signal });
      // Wait for the command's own child to be writing, so there is a tree to end.
      for (let waited = 0; waited < 200 && !existsSync(child.marker); waited += 1) await Bun.sleep(25);
      expect(existsSync(child.marker)).toBe(true);
      withdrawing.abort();
      const refusal = await running.then(() => null).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CommandCancelled);
      expect((refusal as CommandCancelled).treeEnd).toBe('ended');
      expect((refusal as CommandCancelled).message).toContain('withdrawn by its caller');
      expect(isCommandFailure(refusal)).toBe(true);
      // Nothing of that tree is writing any more, which is what `ended` claims. The pause is longer than the
      // child's own interval, and than the bounded run `taskkill` takes to end a tree on Windows.
      await Bun.sleep(1_000);
      const settled = readFileSync(child.marker, 'utf8').length;
      await Bun.sleep(1_000);
      expect(readFileSync(child.marker, 'utf8').length).toBe(settled);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('answers a command that finished before it was withdrawn, and withdrawal changes nothing after', async () => {
    const withdrawing = new AbortController();
    const result = await systemRunner().run(process.execPath, ['-e', "process.stdout.write('done')"], { signal: withdrawing.signal });
    expect([result.code, result.stdout.trim()]).toEqual([0, 'done']);
    withdrawing.abort();
    expect(result.code).toBe(0);
  });

  it('GATE: starts nothing for a caller that has already withdrawn', async () => {
    const root = mkdtempSync(join(tmpdir(), 'myco-runner-prewithdrawn-'));
    const marker = join(root, 'ran');
    const withdrawn = new AbortController();
    withdrawn.abort();
    try {
      const refusal = await systemRunner()
        .run(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)},'ran')`], { signal: withdrawn.signal })
        .then(() => null)
        .catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CommandCancelled);
      // Nothing was started, so nothing of a tree is running — which is what `absent` says, not `ended`.
      expect((refusal as CommandCancelled).treeEnd).toBe('absent');
      expect(isCommandFailure(refusal)).toBe(true);
      // A command that had run would have written this before now.
      await Bun.sleep(500);
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
