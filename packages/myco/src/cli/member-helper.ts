/**
 * `myco member helper --project <id> --home <MYCO_HOME>`: the member helper's own process (#1561, `member/helper.ts`).
 *
 * A hook starts it detached; it can also be run by hand. Everything it needs is on its command line, the home
 * included: a detached start on Windows carries the environment the starting process began with, not one it changed.
 * Its stderr goes to `<MYCO_HOME>/logs/helper.log`.
 */
import { drainEntryBacklog } from '../member/backlog.js';
import { deadlineBudget } from '../member/budget.js';
import { isProjectId } from '../member/constants.js';
import { routeStderrToHelperLog, runHelper, type HelperRunResult } from '../member/helper.js';
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
    return await helperPasses(projectId, mycoHome, deps);
  } finally {
    restoreStderr();
  }
}

/** One pass of the helper over a project, ending by `deadline`: the project's backlog delivered, then its retention. */
export function helperPass(projectId: string, mycoHome: string, deps: Pick<HelperVerbDeps, 'fetch' | 'now'> = {}): (deadline: number) => Promise<void> {
  const now = deps.now ?? Date.now;
  return async (deadline) => {
    // The project's membership: any root this home connects to it, since every root of one project shares its spool.
    const entry = listRegistryEntries(mycoHome).find((candidate) => candidate.projectId === projectId);
    if (entry === undefined) {
      process.stderr.write(`[myco] helper: this home holds no membership for ${projectId}; nothing to ship\n`);
      return;
    }
    const backlog = await drainEntryBacklog(entry, { mycoHome, fetch: deps.fetch, now, budget: deadlineBudget(deadline) });
    applySpoolRetention(new MemberSpool(projectId, { mycoHome }), now(), { tried: backlog.tried });
    const shipped = backlog.sessions.reduce((n, s) => n + (s.events?.acked ?? 0) + (typeof s.transcripts === 'object' ? s.transcripts.shipped : 0), 0);
    process.stderr.write(`[myco] helper: pass over ${backlog.sessions.length} session(s), ${shipped} record(s) and segment(s) delivered, ended by ${backlog.endedBy}\n`);
  };
}

async function helperPasses(projectId: string, mycoHome: string, deps: HelperVerbDeps): Promise<HelperRunResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const result = await runHelper({
    projectId,
    mycoHome,
    now,
    sleep: deps.sleep,
    lingerMs: deps.lingerMs,
    pass: helperPass(projectId, mycoHome, deps),
  });
  process.stderr.write(`[myco] helper: ${result.passes} pass(es) in ${now() - started} ms, ended ${result.endedBy}\n`);
  return result;
}
