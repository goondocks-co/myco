/**
 * Joining a repository with no connection of its own to the machine's default Deployment (#1547), or saying why it
 * cannot. The member helper's join bucket runs it (`joinPass`): for each repository a hook asked about, and once over
 * every repository a hook met before auto-join existed. `myco member auto-join --root <dir>` (or `--sweep`) runs the
 * same by hand. Each attempt holds the repository's lock (`takeRepositoryLock`).
 *
 * For one repository it:
 * 1. asks the Deployment for this machine's settings first, so a repository just connected from "Needs you", or a
 *    folder just added, counts from this attempt;
 * 2. reports a repository outside the folders the machine captures, at most once a day, for "Needs you";
 * 3. for any other, asks the Deployment which project the repository joins, by its remote, and records the answer;
 * 4. on a join, writes the repository's connection, moves its pending capture into the project's spool and delivers
 *    it, then brings the repository's past sessions as `myco member join` does: at once when run by hand, and a step
 *    at a time in the helper's later passes otherwise.
 *
 * A repository left with `myco member leave` is never attempted until "Needs you" connects it again.
 *
 * It writes nothing into the repository: the hooks that start it already resolve this home from the repository.
 */
import { warmProjectContext } from '../member/prefetch.js';
import { MACHINE_UNCAPTURED_REASONS, REPORT_UNCAPTURED_PATH, RESOLVE_PROJECT_PATH, UNCAPTURED_STATE_PATH, isUncapturedReason, type HeldState } from '@goondocks/myco-shared/member-protocol';
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { resolveMycoHome } from '../paths/home.js';
import {
  clearJoinRequest, clearPendingImport, dropJoinRequest, isLeft, joinStanding, listJoinRequests, listPendingImports, markSweepDone, placeRepository, queueImport,
  readAutoJoinState, repositoryAt, sweepDone, takeRepositoryLock,
  clearLeft, forgetAutoJoinState, markLeft, markSessionsReported, nextAttemptAfter, rootKeyFor, silentRepository, UNCAPTURED_REPORT_INTERVAL_MS, unreportedSessions, writeAutoJoinState, type AutoJoinState, type Repository,
} from '../member/auto-join.js';
import { drainEntryBacklog } from '../member/backlog.js';
import type { HelperPass } from '../member/helper.js';
import { CONNECT_TIMEOUT_CAP_MS } from '../member/constants.js';
import { defaultMembership } from '../member/default-deployment.js';
import { IMPORT_DEADLINE, runImport } from '../member/import.js';
import { forgetConnectRoot, machineAutoJoinLeaves, seedMachineSettings } from '../member/machine-settings.js';
import { clearMissingMembership, listMissingMemberships } from '../member/no-membership.js';
import { discardPending, flushPending, readHeldEnd } from '../member/pending.js';
import { readRegistryEntry, REGISTRY_VERSION, withRegistryLock, writeRegistryEntry, type DeploymentMembership, type RegistryEntry } from '../member/registry.js';
import { MemberSpool } from '../member/spool.js';
import { ServerClient, type FetchLike } from '../member/transport.js';
import { postRoute } from './deployment-reader.js';
import type { MemberCliDeps } from './member.js';

/** How long one request of a join waits for the Deployment. */
const REQUEST_TIMEOUT_MS = 30_000;

/** What one repository's attempt came to. */
export type AutoJoinResult =
  | { root: string; result: 'joined'; projectId: string; moved: number; imported: number }
  | { root: string; result: 'connected' }
  | { root: string; result: 'silent' | 'busy' | 'left' }
  | { root: string; result: AutoJoinState['outcome']; reason?: string };

interface AutoJoinArgs { root?: string; sweep: boolean; error?: string }

function parseArgs(args: readonly string[]): AutoJoinArgs {
  const parsed: AutoJoinArgs = { sweep: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--root') {
      const next = args[++i];
      if (next === undefined || next.startsWith('--')) parsed.error ??= '--root needs a value';
      else parsed.root = next;
    } else if (arg === '--sweep') parsed.sweep = true;
    else parsed.error ??= `unknown option ${arg.split('=')[0]}`;
  }
  if (parsed.root === undefined && !parsed.sweep) parsed.error ??= 'name the repository with --root <dir>, or pass --sweep';
  return parsed;
}

/** How long telling the Deployment what became of a repository waits; a connection never waits on it. */
const STATE_TIMEOUT_MS = 10_000;

/**
 * Settle a repository that is connected, however it came to be: move what its hooks held into the project's spool,
 * mark it joined, and, where the Deployment may still list it, say it is connected. Run by every join, by `myco member
 * join`, and by the next attempt after a join that stopped between writing the connection and moving the capture. How
 * many records moved.
 */
export async function settleConnection(entry: RegistryEntry, opts: { mycoHome: string; now: () => number; fetch?: FetchLike; tell: boolean }): Promise<number> {
  const rootKey = rootKeyFor(entry.root, opts.mycoHome);
  // Joined again: a repository left with `myco member leave` is captured from now on, and a join a hook asked for is
  // made.
  clearLeft(rootKey, opts.mycoHome);
  dropJoinRequest(rootKey, opts.mycoHome);
  const moved = flushPending(rootKey, new MemberSpool(entry.projectId, { mycoHome: opts.mycoHome }), { mycoHome: opts.mycoHome, now: opts.now() });
  const state = readAutoJoinState(rootKey, opts.mycoHome);
  if (state !== null && state.outcome !== 'joined') writeAutoJoinState({ ...state, outcome: 'joined', reason: undefined, detail: undefined, projectId: entry.projectId, attemptAt: opts.now() }, opts.mycoHome);
  // Only a repository this machine tried to join can be listed for "Needs you"; any other has nothing to forget.
  if (opts.tell && state !== null && state.outcome !== 'joined') {
    const client = new ServerClient({ serverUrl: entry.serverUrl, token: entry.token }, opts.fetch ?? globalThis.fetch);
    await postRoute(client, { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: STATE_TIMEOUT_MS }, UNCAPTURED_STATE_PATH, { rootKey, state: 'connected' }).catch(() => null);
  }
  // The Project's blocks, cached before the repository's first session asks: it is served them whole.
  await warmProjectContext(entry, { mycoHome: opts.mycoHome, fetch: opts.fetch, now: opts.now }).catch(() => 0);
  return moved;
}

/** What an attempt runs with: `importNow` brings the past sessions in the attempt (by hand); the helper queues them. */
type AttemptRun = MemberCliDeps & { mycoHome: string; now: () => number; importNow: boolean };

/** Join one repository, or record why it did not. The caller holds the repository's lock. */
async function joinRepository(root: string, membership: DeploymentMembership, deps: AttemptRun): Promise<AutoJoinResult> {
  const { mycoHome, now } = deps;
  const connected = readRegistryEntry(root, mycoHome);
  if (connected !== null) {
    // Connected already: by `myco member join`, or by a join that stopped before moving the held capture.
    await settleConnection(connected, { mycoHome, now, fetch: deps.fetch, tell: false });
    return { root, result: 'connected' };
  }
  if (silentRepository(root, { mycoHome, env: deps.env })) return { root, result: 'silent' };
  const repo: Repository = repositoryAt(root, mycoHome);
  const previous = readAutoJoinState(repo.rootKey, mycoHome);

  await seedMachineSettings({ serverUrl: membership.serverUrl, token: membership.token }, { mycoHome, fetch: deps.fetch });
  const leaves = machineAutoJoinLeaves(membership.serverUrl, mycoHome);
  const placement = placeRepository(repo, leaves);
  const connectTo = Object.prototype.hasOwnProperty.call(leaves.connectRoots, repo.rootKey) ? leaves.connectRoots[repo.rootKey]! : null;
  // Left with `myco member leave`, by the settings just read: no attempt joins it until "Needs you" connects it.
  if (isLeft(repo.rootKey, mycoHome)) {
    if (connectTo === null) return { root, result: 'left' };
    clearLeft(repo.rootKey, mycoHome);
  }
  const client = new ServerClient({ serverUrl: membership.serverUrl, token: membership.token }, deps.fetch ?? globalThis.fetch);
  const budget = { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS };
  // What this machine holds of the repository's capture now, and the sessions that met it after its last report: the
  // machine is the authority on both, and says them every time.
  const held: HeldState = readHeldEnd(repo.rootKey, mycoHome)?.held ?? 'held';
  const sessions = unreportedSessions(repo.rootKey, mycoHome);
  // The remote leaves as its canonical name, credentials and port already gone, in a form every Deployment reads.
  const named = { rootKey: repo.rootKey, label: repo.label, ...(repo.remote === null ? {} : { remote: `https://${repo.remote}` }), held, sessions };

  /**
   * Record a miss, backing the next attempt off while the same miss repeats under the same settings: twice the wait
   * each time, to the cap. A new reason, or settings that place the repository elsewhere, start the wait over.
   */
  const recordMiss = (state: Pick<AutoJoinState, 'outcome' | 'reason' | 'detail'> & { reportedAt?: number; reportedHeld?: HeldState }): void => {
    const same = previous !== null && previous.outcome === state.outcome && previous.reason === state.reason
      && previous.placement === placement && (previous.connectTo ?? null) === connectTo;
    const repeats = same ? (previous!.repeats ?? 1) + 1 : 1;
    writeAutoJoinState({
      root: repo.root, rootKey: repo.rootKey, label: repo.label, serverUrl: membership.serverUrl, attemptAt: now(),
      nextAttemptAt: nextAttemptAfter(now(), repeats), repeats, placement, connectTo,
      reportedAt: previous?.reportedAt, reportedHeld: previous?.reportedHeld, ...state,
    }, mycoHome);
  };

  if (placement === 'outside_folders') {
    // Reported once a day, and whenever there is something new to say: sessions that met it, or a change in its hold.
    const due = previous?.reportedAt === undefined || now() - previous.reportedAt >= UNCAPTURED_REPORT_INTERVAL_MS
      || sessions > 0 || previous.reportedHeld !== held;
    const reported = due ? await postRoute(client, budget, REPORT_UNCAPTURED_PATH, { ...named, reason: MACHINE_UNCAPTURED_REASONS[0] }) : null;
    if (reported?.ok === true) markSessionsReported(repo.rootKey, sessions, mycoHome);
    recordMiss({
      outcome: 'outside_folders', reason: 'outside_folders',
      ...(reported?.ok === true ? { reportedAt: now(), reportedHeld: held } : {}),
    });
    return { root, result: 'outside_folders' };
  }

  const answer = await postRoute(client, budget, RESOLVE_PROJECT_PATH, named);
  if (!answer.ok) {
    const reason = isUncapturedReason(answer.error.code) ? answer.error.code : undefined;
    // An answer naming why is the Deployment's decision, and recorded it with the sessions; anything else is a
    // Deployment not reached, tried again later.
    if (reason !== undefined) markSessionsReported(repo.rootKey, sessions, mycoHome);
    recordMiss(reason !== undefined
      ? { outcome: 'missed', reason, detail: answer.error.message, reportedAt: now(), reportedHeld: held }
      : { outcome: 'unreachable', detail: answer.error.message });
    return { root, result: reason !== undefined ? 'missed' : 'unreachable', reason: reason ?? answer.error.code };
  }
  const projectId = String(answer.value.projectId);

  // A connection written while this asked (`myco member join`, another attempt) is the one that stands.
  const entry = withRegistryLock(() => {
    const held = readRegistryEntry(root, mycoHome);
    if (held !== null) return null;
    const written: RegistryEntry = {
      version: REGISTRY_VERSION, projectId, serverUrl: membership.serverUrl, token: membership.token, root,
      machineId: membership.machineId ?? getMachineId(), joinedAt: now(), updatedAt: now(),
    };
    writeRegistryEntry(written, { mycoHome, locked: true });
    return written;
  }, mycoHome);
  if (entry === null) return { root, result: 'connected' };
  clearMissingMembership(root, mycoHome);
  markSessionsReported(repo.rootKey, sessions, mycoHome);
  writeAutoJoinState({ root: repo.root, rootKey: repo.rootKey, label: repo.label, serverUrl: membership.serverUrl, attemptAt: now(), outcome: 'joined', projectId, placement, connectTo }, mycoHome);

  // The Deployment cleared its row as it answered; nothing more to tell it.
  const moved = await settleConnection(entry, { mycoHome, now, fetch: deps.fetch, tell: false });
  // What moved is delivered here, in the process making the join (the helper's join bucket, or a run by hand): the
  // session leases keep it apart from the project's own helper.
  try {
    await drainEntryBacklog(entry, { mycoHome, fetch: deps.fetch, now, machineId: entry.machineId });
  } catch {
    // The moved capture stays spooled; the project's helper delivers it at the repository's next hook.
  }
  // The past sessions come last, once the connection is settled: the helper brings them a step at a time in later
  // passes, so one repository's history never holds another's first join.
  if (!deps.importNow) {
    queueImport({ root, rootKey: repo.rootKey, projectId, serverUrl: membership.serverUrl, at: now() }, mycoHome);
    return { root, result: 'joined', projectId, moved, imported: 0 };
  }
  const report = await runImport({ project: projectId, serverUrl: membership.serverUrl }, {
    fetch: deps.fetch, now: deps.now, cwd: root, mycoHome, machineId: entry.machineId,
  }).catch(() => null);
  return { root, result: 'joined', projectId, moved, imported: importedBy(report) };
}

const importedBy = (report: Awaited<ReturnType<typeof runImport>> | null): number =>
  report?.projects.reduce((n, p) => n + p.agents.reduce((m, a) => m + a.imported, 0), 0) ?? 0;

/**
 * The repositories a hook met before auto-join, for the sweep: on disk still, not connected, not left, and not yet
 * tried (a repository tried since is the hooks' to ask for).
 */
function sweepCandidates(mycoHome: string): string[] {
  return listMissingMemberships(mycoHome)
    .map((record) => record.root)
    .filter((root) => {
      if (!fs.existsSync(root) || readRegistryEntry(root, mycoHome) !== null) return false;
      const rootKey = rootKeyFor(root, mycoHome);
      return !isLeft(rootKey, mycoHome) && readAutoJoinState(rootKey, mycoHome) === null;
    });
}

/** One attempt at `root`, holding its lock: busy where another attempt holds it. */
async function attempt(root: string, membership: DeploymentMembership, run: AttemptRun): Promise<AutoJoinResult> {
  const lock = takeRepositoryLock(rootKeyFor(root, run.mycoHome), run.mycoHome);
  if (lock === null) return { root, result: 'busy' };
  try { return await joinRepository(root, membership, run); } finally { lock.release(); }
}

/**
 * The sweep over repositories a hook met before auto-join, once per machine: marked done once every candidate has had
 * its attempt. Stopped at `deadline`, it is not done, and the next pass carries on with the candidates left.
 */
async function sweep(membership: DeploymentMembership, run: AttemptRun, err: (line: string) => void, deadline?: number): Promise<{ results: AutoJoinResult[]; done: boolean }> {
  const results: AutoJoinResult[] = [];
  for (const root of sweepCandidates(run.mycoHome)) {
    if (deadline !== undefined && run.now() >= deadline) return { results, done: false };
    try {
      results.push(await attempt(root, membership, run));
    } catch (error) {
      err(`myco member auto-join: ${root}: ${(error as Error).message}`);
    }
  }
  markSweepDone(run.mycoHome, run.now());
  return { results, done: true };
}

/**
 * The member helper's join pass (`JOIN_BUCKET`), each step stopping at `deadline` and leaving the rest for the pass,
 * or the successor, after it:
 * 1. each repository a hook asked about, the oldest first, checked again by the rule the hook applied
 *    (`joinStanding`): one left, one no longer due (an attempt made since it was asked), or one asked for under another
 *    Deployment than the default is dropped; any other is attempted, and its request dropped once it is. A repository
 *    another attempt holds keeps its request;
 * 2. the past sessions of each repository joined, a step at a time;
 * 3. the sweep, once per machine.
 */
export function joinPass(mycoHome: string, deps: { fetch?: FetchLike; now?: () => number } = {}): HelperPass {
  const now = deps.now ?? Date.now;
  const err = (line: string) => process.stderr.write(`[myco] helper: ${line}\n`);
  return async (deadline) => {
    const membership = defaultMembership(mycoHome);
    const run: AttemptRun = { fetch: deps.fetch, mycoHome, now, importNow: false };
    for (const request of listJoinRequests(mycoHome)) {
      if (now() >= deadline) return { more: true };
      if (membership === null || request.serverUrl !== membership.serverUrl
        || joinStanding(request.root, request.rootKey, membership.serverUrl, mycoHome, now()).standing !== 'due') {
        clearJoinRequest(request, mycoHome);
        continue;
      }
      let result: AutoJoinResult;
      try {
        result = await attempt(request.root, membership, run);
      } catch (error) {
        err(`auto-join: ${request.root}: ${(error as Error).message}`);
        clearJoinRequest(request, mycoHome);
        continue;
      }
      err(`auto-join ${request.root}: ${result.result}${'projectId' in result ? ` ${result.projectId}` : ''}`);
      if (result.result !== 'busy') clearJoinRequest(request, mycoHome);
    }
    if (membership === null) return;

    for (const pending of listPendingImports(mycoHome)) {
      if (now() >= deadline) return { more: true };
      const entry = readRegistryEntry(pending.root, mycoHome);
      // Left, or connected elsewhere since: its history is not this join's to bring.
      if (entry === null || entry.projectId !== pending.projectId || entry.serverUrl !== pending.serverUrl) {
        clearPendingImport(pending.rootKey, mycoHome);
        continue;
      }
      const report = await runImport({ project: pending.projectId, serverUrl: pending.serverUrl, until: deadline }, {
        fetch: deps.fetch, now, cwd: pending.root, mycoHome, machineId: entry.machineId,
      }).catch(() => null);
      if (report?.projects.some((project) => project.endedBy === IMPORT_DEADLINE) === true) return { more: true };
      clearPendingImport(pending.rootKey, mycoHome);
      err(`auto-join ${pending.root}: imported ${importedBy(report)} past session(s)`);
    }

    if (!sweepDone(mycoHome) && !(await sweep(membership, run, err, deadline)).done) return { more: true };
  };
}

export async function runAutoJoin(args: readonly string[], deps: MemberCliDeps = {}): Promise<AutoJoinResult[]> {
  const err = deps.stderr ?? ((l) => process.stderr.write(`${l}\n`));
  const parsed = parseArgs(args);
  if (parsed.error !== undefined) { err(`myco member auto-join: ${parsed.error}`); process.exitCode = 2; return []; }
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: parsed.root ?? deps.cwd });
  const now = deps.now ?? Date.now;
  const membership = defaultMembership(mycoHome);
  if (membership === null) return [];
  const run: AttemptRun = { ...deps, mycoHome, now, importNow: true };
  if (!parsed.sweep) {
    const root = path.resolve(parsed.root!);
    const result = await attempt(root, membership, run);
    // Made by hand: a request a hook left for it is answered, whatever came of the attempt.
    if (result.result !== 'busy') dropJoinRequest(rootKeyFor(root, mycoHome), mycoHome);
    return [result];
  }
  return (await sweep(membership, run, err)).results;
}

/**
 * Opt a repository out of auto-join, as `myco member leave` there does: its hooks capture nothing, hold nothing and say
 * nothing; its held capture is discarded; and the Deployment forgets it and stops telling this machine to connect
 * it. Joining it again, or connecting it again from "Needs you", ends the opt-out. The Deployment is told without
 * waiting; a Deployment not reached keeps its row until a month passes.
 */
export function optOut(root: string, membership: { serverUrl: string; token: string } | null, opts: { mycoHome: string; now: number; fetch?: FetchLike }): Promise<unknown> {
  const rootKey = rootKeyFor(root, opts.mycoHome);
  markLeft(rootKey, opts.mycoHome, opts.now);
  // Nothing asked for it before is made: no join, and no past sessions brought.
  dropJoinRequest(rootKey, opts.mycoHome);
  clearPendingImport(rootKey, opts.mycoHome);
  discardPending(rootKey, opts.mycoHome);
  // Whatever auto-join found before is forgotten: connected again, the repository starts from nothing.
  forgetAutoJoinState(rootKey, opts.mycoHome);
  if (membership === null) return Promise.resolve();
  forgetConnectRoot(membership.serverUrl, rootKey, opts.mycoHome);
  const client = new ServerClient({ serverUrl: membership.serverUrl, token: membership.token }, opts.fetch ?? globalThis.fetch);
  return postRoute(client, { connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS, requestTimeoutMs: STATE_TIMEOUT_MS }, UNCAPTURED_STATE_PATH, { rootKey, state: 'left' }).catch(() => null);
}
