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
import { attemptAutomaticUpdate, automaticUpdateWords } from '@myco/member/automatic-update-state.js';
import { updateBinary, binaryUpdatePath, type BinaryUpdateDeps } from '@myco/upgrade/guarded-binary.js';
import { refreshMemberSetup } from '@myco/member/refresh-setup.js';
import { readProvisionRecord } from '@myco/member/provision-record.js';
import { keepCurrent, reportHarnesses } from '@myco/cli/member-keep-current.js';

export { helperPass } from '../member/helper-pass.js';

export const AUTOMATIC_UPDATE_MIN_BUDGET_MS = 30_000;

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
  keepCurrent?: typeof keepCurrent;
  updateBinary?: typeof updateBinary;
  binaryUpdateDeps?: BinaryUpdateDeps;
  refreshMember?: typeof refreshMemberSetup;
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
  const serverUrl = flag(args, '--server');
  if (projectId === undefined || (projectId !== JOIN_BUCKET && !isProjectId(projectId)) || (projectId !== JOIN_BUCKET && !serverUrl) || mycoHome === undefined || mycoHome === '') {
    process.stderr.write('usage: myco member helper (--project <project id> --server <Deployment URL> | --join) --home <MYCO_HOME>\n');
    process.exitCode = 2;
    return null;
  }
  // The home this helper serves is the one every lookup in it, and every process it starts, resolves: a start on Windows
  // carries the starter's original environment, and a wrapper's default home must not stand in for this one.
  const priorHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = mycoHome;
  const restoreStderr = deps.keepStderr || args.includes('--stderr') ? () => {} : routeStderrToHelperLog(mycoHome, projectId, serverUrl);
  try {
    return await helperPasses(projectId, serverUrl, mycoHome, args.includes('--after-failure'), deps);
  } finally {
    restoreStderr();
    if (priorHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = priorHome;
  }
}

async function helperPasses(projectId: string, serverUrl: string | undefined, mycoHome: string, afterFailure: boolean, deps: HelperVerbDeps): Promise<HelperRunResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const pass = deps.pass ?? (projectId === JOIN_BUCKET ? (await import('./member-auto-join.js')).joinPass(mycoHome, deps) : helperPass({ projectId, serverUrl: serverUrl! }, mycoHome, deps));
  let result: HelperRunResult;
  let adoptedVersion: string | undefined;
  const refreshAdopted = (deadline: number) => {
    const remaining = deadline - now();
    if (remaining <= 0) throw new Error('not enough time remains to refresh agents');
    return (deps.refreshMember ?? refreshMemberSetup)(binaryUpdatePath(mycoHome, deps.binaryUpdateDeps), mycoHome, remaining);
  };
  try {
    result = await runHelper({
      projectId,
      serverUrl,
      mycoHome,
      now,
      sleep: deps.sleep,
      lingerMs: deps.lingerMs,
      deadlineMs: deps.deadlineMs,
      spawn: deps.spawn,
      afterFailure,
      pass: async (deadline, options) => {
        let repaired: ReturnType<typeof keepCurrent> = null;
        let refreshedAdoption = false;
        if (deadline - now() >= AUTOMATIC_UPDATE_MIN_BUDGET_MS) {
          try {
            const checked = await attemptAutomaticUpdate(mycoHome, now, async () => {
              const outcome = await (deps.updateBinary ?? updateBinary)('automatic', {}, { ...deps.binaryUpdateDeps, home: mycoHome, deadline, now });
              if (outcome.kind === 'adopted') {
                adoptedVersion = outcome.version;
                refreshedAdoption = true;
              }
              return outcome;
            }, async () => { await refreshAdopted(deadline); });
            if (checked !== null) {
              process.stderr.write(`[myco] automatic update: ${automaticUpdateWords(checked.lastOutcome)}\n`);
            }
          } catch (error) {
            process.stderr.write(`[myco] automatic update check failed: ${error instanceof Error ? error.message : String(error)}\n`);
          }
        }
        try {
          if (adoptedVersion !== undefined) {
            if (!refreshedAdoption && readProvisionRecord(mycoHome)?.version !== adoptedVersion) await refreshAdopted(deadline);
          } else repaired = (deps.keepCurrent ?? keepCurrent)(mycoHome);
        } catch (error) {
          process.stderr.write(`[myco] keep-current failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        const delivered = await pass(deadline, options);
        try { await reportHarnesses(repaired, mycoHome, deadline, deps); } catch (error) {
          process.stderr.write(`[myco] harness report failed: ${error instanceof Error ? error.message : String(error)}\n`);
        }
        return delivered;
      },
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
    for (const { projectId: other, outcome } of kickWaitingProjects(mycoHome, serverUrl === undefined ? projectId : { projectId, serverUrl }, { now, spawn: deps.spawn })) {
      process.stderr.write(`[myco] helper: kicked ${other}, which holds undelivered work (${outcome.kind})\n`);
    }
  }
  return result;
}
