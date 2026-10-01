/**
 * `myco member helper --project <id> --home <MYCO_HOME> [--after-failure]`: the member helper's own process
 * (`member/helper.ts`).
 *
 * A hook starts it detached; it can also be run by hand. Everything it needs is on its command line, the home
 * included: a detached start on Windows carries the environment the starting process began with, not one it changed.
 * Its stderr goes to `<MYCO_HOME>/logs/helper.log`, a pass that fails included.
 */
import { drainEntryBacklog } from '../member/backlog.js';
import { deadlineBudget } from '../member/budget.js';
import { isProjectId } from '../member/constants.js';
import { routeStderrToHelperLog, runHelper, type HelperPass, type HelperRunResult } from '../member/helper.js';
import type { DetachedSpawn } from '../runtime/spawn-detached.js';
import { listRegistryEntries } from '../member/registry.js';
import { applySpoolRetention } from '../member/retention.js';
import { MemberSpool } from '../member/spool.js';
import type { FetchLike } from '../member/transport.js';

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
  const projectId = flag(args, '--project');
  const mycoHome = flag(args, '--home');
  if (projectId === undefined || !isProjectId(projectId) || mycoHome === undefined || mycoHome === '') {
    process.stderr.write('usage: myco member helper --project <project id> --home <MYCO_HOME>\n');
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

/** One pass of the helper over a project, ending by `deadline`: the project's backlog delivered, then its retention. */
export function helperPass(projectId: string, mycoHome: string, deps: Pick<HelperVerbDeps, 'fetch' | 'now'> = {}): HelperPass {
  const now = deps.now ?? Date.now;
  return async (deadline, { force }) => {
    // The project's membership: any root this home connects to it, since every root of one project shares its spool.
    const entry = listRegistryEntries(mycoHome).find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      process.stderr.write(`[myco] helper: this home holds no membership for ${projectId}; nothing to ship\n`);
      return;
    }
    const backlog = await drainEntryBacklog(entry, { mycoHome, fetch: deps.fetch, now, budget: deadlineBudget(deadline), force, rescan: false });
    applySpoolRetention(new MemberSpool(projectId, { mycoHome }), now(), { tried: backlog.tried });
    const shipped = backlog.sessions.reduce((n, s) => n + (s.events?.acked ?? 0) + (typeof s.transcripts === 'object' ? s.transcripts.shipped : 0), 0);
    process.stderr.write(`[myco] helper: pass over ${backlog.sessions.length} session(s), ${shipped} record(s) and segment(s) delivered${force ? ' (past the offline latch)' : ''}, ended by ${backlog.endedBy}\n`);
    return { more: backlog.endedBy === 'budget' };
  };
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
      pass: deps.pass ?? helperPass(projectId, mycoHome, deps),
    });
  } catch (err) {
    // Written while stderr is still the helper's log: a detached helper has nowhere else to say why it stopped.
    process.stderr.write(`[myco] helper: a pass failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.stderr.write(`[myco] helper: ended after ${now() - started} ms by a failed pass; ${afterFailure ? 'its work waits for the next kick' : 'a successor takes its work'}\n`);
    throw err;
  }
  const successor = result.successor === undefined ? '' : `; successor ${result.successor}`;
  process.stderr.write(`[myco] helper: ${result.passes} pass(es) in ${now() - started} ms, ended ${result.endedBy}${successor}\n`);
  return result;
}
