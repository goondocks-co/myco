/**
 * `myco member helper (--project <id> | --join) --home <MYCO_HOME> [--after-failure]`: the member helper's own process
 * (`member/helper.ts`), for one project's spool, or (`--join`) for the repositories joining a project (`JOIN_BUCKET`,
 * the join pass of `cli/member-auto-join.ts`).
 *
 * A hook starts it detached; it can also be run by hand. Everything it needs is on its command line, the home
 * included: a detached start on Windows carries the environment the starting process began with, not one it changed.
 * Its stderr goes to `<MYCO_HOME>/logs/helper.log`, a pass that fails included.
 */
import { isProjectId } from '../member/constants.js';
import { JOIN_BUCKET } from '../member/auto-join.js';
import { routeStderrToHelperLog, runHelper, type HelperPass, type HelperRunResult } from '../member/helper.js';
import { helperPass } from '../member/helper-pass.js';
import { kickWaitingProjects } from '../member/sweep.js';
import { recordStartingJob, type DetachedSpawn } from '../runtime/spawn-detached.js';
import type { FetchLike } from '../member/transport.js';

export { helperPass } from '../member/helper-pass.js';

export interface HelperVerbDeps {
  fetch?: FetchLike;
  now?: () => number;
  /** Leave stderr where it is (tests, and a person running the helper by hand with `--stderr`). */
  keepStderr?: boolean;
  sleep?: (ms: number) => Promise<void>;
  lingerMs?: number;
  deadlineMs?: number;
  /** How a successor is started (tests). */
  spawn?: DetachedSpawn;
  /** The pass the helper runs (tests); the project's backlog delivery otherwise. */
  pass?: HelperPass;
}

function flag(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

export async function runHelperVerb(args: readonly string[], deps: HelperVerbDeps = {}): Promise<HelperRunResult | null> {
  // A successor started from this helper can outlive it only as far as the job this helper began in allows.
  recordStartingJob();
  const projectId = args.includes('--join') ? JOIN_BUCKET : flag(args, '--project');
  const mycoHome = flag(args, '--home');
  if (projectId === undefined || (projectId !== JOIN_BUCKET && !isProjectId(projectId)) || mycoHome === undefined || mycoHome === '') {
    process.stderr.write('usage: myco member helper (--project <project id> | --join) --home <MYCO_HOME>\n');
    process.exitCode = 2;
    return null;
  }
  const restoreStderr = deps.keepStderr || args.includes('--stderr') ? () => {} : routeStderrToHelperLog(mycoHome, projectId);
  try {
    return await helperPasses(projectId, mycoHome, args.includes('--after-failure'), deps);
  } finally {
    restoreStderr();
  }
}

async function helperPasses(projectId: string, mycoHome: string, afterFailure: boolean, deps: HelperVerbDeps): Promise<HelperRunResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  let result: HelperRunResult;
  try {
    result = await runHelper({
      projectId,
      mycoHome,
      now,
      sleep: deps.sleep,
      lingerMs: deps.lingerMs,
      deadlineMs: deps.deadlineMs,
      spawn: deps.spawn,
      afterFailure,
      pass: deps.pass ?? (projectId === JOIN_BUCKET ? (await import('./member-auto-join.js')).joinPass(mycoHome, deps) : helperPass(projectId, mycoHome, deps)),
    });
  } catch (err) {
    // Written while stderr is still the helper's log: a detached helper has nowhere else to say why it stopped.
    process.stderr.write(`[myco] helper: a pass failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`[myco] helper: ended after ${now() - started} ms by a failed pass; ${afterFailure ? 'its work waits for the next kick' : 'a successor takes its work'}\n`);
    throw err;
  }
  const successor = result.successor === undefined ? '' : `; successor ${result.successor}`;
  process.stderr.write(`[myco] helper: ${result.passes} pass(es) in ${now() - started} ms, ended ${result.endedBy}${successor}\n`);
  // The other projects this home holds work for: their helpers start on this hook, not on their own next session.
  if (result.endedBy !== 'busy') {
    for (const { projectId: other, outcome } of kickWaitingProjects(mycoHome, projectId, { now, spawn: deps.spawn })) {
      process.stderr.write(`[myco] helper: kicked ${other}, which holds undelivered work (${outcome.kind})\n`);
    }
  }
  return result;
}
