/**
 * Bringing a machine's existing agent history to a Deployment (#1148).
 *
 * A member that joins arrives empty. Every harness this machine runs has been
 * writing transcripts all along, and nothing has ever shipped them: hooks
 * capture from the moment they are installed, and the past is only reachable by
 * walking the disk. That walk is what this is.
 *
 * It ships through exactly the path a live turn ships through — the same
 * `transcript.segment` events, the same offsets, the same parse — so it adds no
 * second way for a transcript to become rows. What it adds is the three
 * questions a live turn never has to ask.
 *
 * **Which Project does this belong to?** A store is not project-scoped:
 * `~/.claude/projects/` holds every project on the machine. A hook never faces
 * this because it fires from inside one. So each transcript is attributed to a
 * project root, the root is resolved to a Project through the local registry,
 * and the pass runs once per Project under its own credential header. A machine
 * with three checkouts on one Deployment imports all three; a transcript whose
 * root this Deployment has no binding for is reported, never guessed at.
 *
 * **Is it already there?** Shipping to find out is expensive in the one
 * direction that matters: the bytes are uploaded before the event that
 * references them is admitted, so re-importing what the Deployment holds
 * charges a blob and then loses the event. The plan route answers first.
 *
 * **How much of it?** The Deployment's own bounds, widened by what the caller
 * asked for. The bounds are the Deployment's because a member's disk is not a
 * Deployment's storage budget.
 *
 * The pass is resumable and carries nothing between runs but what the session
 * state already holds: a killed import re-plans and continues from the byte the
 * server acknowledged.
 */
import fs from 'node:fs';
import { transcriptPlacer, type DirectoryMapping } from '../symbionts/transcript-attribution.js';
import { enumerateTranscripts, manifestTranscriptDiscovery } from '../symbionts/transcript-discovery.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { evaluateSessionCaptureRules } from '../hooks/capture-rules.js';
import { readTranscriptMeta } from '../hooks/transcript-meta.js';
import { resolveMycoHome } from '../paths/home.js';
import { unboundedBudget } from './budget.js';
import { resolveMemberProjectRoot } from './credential.js';
import { sessionEndEvent, sessionStartEvent, type EnvelopeContext } from './envelope.js';
import { listRegistryEntries, type RegistryEntry } from './registry.js';
import { MemberSpool } from './spool.js';
import { legacySessionsToLeaveOut } from './legacy-ledger.js';
import { readSessionState } from './session-state.js';
import { shipTranscriptSegments, transcriptHeadHash, transcriptPointerFor } from './transcript.js';
import { ServerClient, type FetchLike } from './transport.js';

/** Candidates one plan request carries. The newest this many by modification time are offered; the Deployment applies its own bounds to them. */
export const IMPORT_PLAN_MAX_CANDIDATES = 1000;
/** Files one agent's store is walked for before the walk itself is bounded. Far above any real store, so the trim that decides what is offered is the sorted one. */
export const ENUMERATION_CEILING = 100_000;

/**
 * How recently a transcript may have been written and still be treated as
 * history.
 *
 * An import that takes a file still being written imports a session that has
 * not finished, and says it ended — at the mtime it happened to read. Most of
 * that corrects itself, since `session.end` keeps the later of two instants and
 * the hook ships the real one. What does not correct itself in the meantime is
 * that the session reads as ended: a list of open sessions misses one that is
 * open, and the reads that assemble extraction material take ended sessions,
 * so a half-finished session can be handed to extraction as a complete one.
 *
 * Ten minutes, against the MEMBER's clock rather than the Deployment's. The
 * window and the per-harness cap are the Deployment's bounds and are applied
 * where it can see the whole pass; this one compares a file's mtime to the
 * clock that read it, and a bound of minutes cannot be compared across two
 * clocks that are allowed to differ by five.
 *
 * A session that is open but idle past the floor is imported, and that is the
 * intended trade: it is closed early, and the hook's real end corrects it.
 */
export const IMPORT_ACTIVE_FLOOR_MS = 10 * 60_000;

/** Directories under the member's own home that no discovery root may reach into, whatever a manifest declares. */
const MEMBER_STATE_DIRS = ['spool', 'deployments', 'projects'] as const;

/** What the caller asked for. Every field narrows or widens; none is required. */
export interface ImportOptions {
  windowDays?: number;
  maxPerAgent?: number;
  /** One agent by manifest name, where a caller wants only that harness's history. */
  agent?: string;
  /** One Project id, where a caller wants only that Project's. */
  project?: string;
  /**
   * The Deployment to import into.
   *
   * Required in effect: a machine may hold a membership of more than one, and
   * the registry answers them in the order its filenames hash, so choosing for
   * the caller means importing into whichever Deployment happens to sort first.
   * The join paths pass the Deployment they just joined; the verb resolves the
   * one bound to its own checkout, and refuses rather than guessing when that
   * leaves more than one.
   */
  serverUrl?: string;
  dryRun?: boolean;
  /** Candidates one plan request carries. The Deployment's cap by default; a test lowers it to reach the trim without writing a thousand files. */
  offerLimit?: number;
  /** Recorded working directories mapped onto a bound root, for the directories no checkout on disk still answers for. */
  mappings?: readonly DirectoryMapping[];
  /** Session ids never offered: sessions deleted in a record this import does not read. */
  exclude?: ReadonlySet<string>;
  /**
   * When to stop: no session starts shipping at or past it, and the report ends `deadline`. What was not shipped is
   * offered again by the next import, which the Deployment's plan resumes from the byte it holds.
   */
  until?: number;
}

/** How an import stopped at its `until`. */
export const IMPORT_DEADLINE = 'deadline';

export interface ImportDeps {
  /** How a paced import waits for its next request slot; the default really waits. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: FetchLike;
  /** Requests a minute this import stays under, leaving the rest of the credential's rate budget to the hooks capturing live. Unpaced when absent. */
  pace?: number;
  now?: () => number;
  cwd?: string;
  mycoHome?: string;
  machineId: string;
}

/** What one agent's store yielded for one Project. Counts rather than a capability table: what a store holds is measured, not declared. */
export interface AgentTally {
  agent: string;
  /** Transcripts on disk for this agent that belong to this Project. */
  found: number;
  imported: number;
  /** Admitted, then gone from the disk before a byte of it could be sent. Never counted as imported: nothing was. */
  vanished: number;
  /** Belonging to this Project but past the offer cap, so never offered. Newest first, so these are the oldest. */
  trimmed: number;
  skipped: Record<string, number>;
}

export interface ProjectReport {
  projectId: string;
  root: string;
  agents: AgentTally[];
  /** Set when the pass stopped before it finished this Project; the class the transport answered. */
  endedBy?: string;
}

export interface ImportReport {
  projects: ProjectReport[];
  /** Transcripts found on disk whose root no binding on this Deployment names. */
  unbound: number;
  unattributable: number;
  /** Transcripts written too recently to be history, left for the hook capturing them. */
  active: number;
  /** Projects `--project` excluded that this machine holds history for. */
  narrowed?: string[];
  /** Transcripts the agent's capture rules drop from live capture, left out the same way. */
  dropped: number;
  /** Transcripts of sessions the caller excluded. */
  excluded: number;
  /** The recorded directories of the unbound transcripts, with how many each holds. */
  unboundDirectories: Record<string, number>;
  refused?: string;
  /** Why a pass that ended on a retryable answer was not tried again. */
  stoppedBy?: string;
}

export interface Candidate {
  sessionId: string;
  transcriptId: string;
  agent: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: number;
  headHash: string | null;
  root: string;
}

/** A path inside the member's own state, whatever a manifest says. A store Myco keeps beside its spool is one thing; the spool, the staged blob bytes and the credential registry are never transcripts. */
export function isMemberStatePath(filePath: string, mycoHome: string): boolean {
  const memberRoot = `${mycoHome.replace(/\/+$/, '')}/member/`;
  if (!filePath.startsWith(memberRoot)) return false;
  const rest = filePath.slice(memberRoot.length);
  return MEMBER_STATE_DIRS.some((dir) => rest === dir || rest.startsWith(`${dir}/`));
}

/** Every agent whose manifest says where its transcripts live. Absent for the agents whose plugin posts complete events and leaves nothing to mine. */
function agentsWithStores(only: string | undefined): string[] {
  return Object.keys(HOOK_CONFIG)
    .filter((agent) => manifestTranscriptDiscovery(agent) !== undefined)
    .filter((agent) => only === undefined || agent === only)
    .sort();
}

/**
 * The Deployment of the checkout the caller is standing in, or null when that
 * does not name one.
 *
 * The fallback for a machine holding several memberships: the working directory
 * is the only thing that distinguishes them without asking.
 */
function deploymentForRoot(entries: readonly RegistryEntry[], cwd: string | undefined): string | null {
  let root: string;
  try { root = resolveMemberProjectRoot(cwd); } catch { return null; }
  return entries.find((e) => e.root === root)?.serverUrl ?? null;
}

/** The Project bindings this Deployment holds on this machine, by project root. */
function bindingsFor(serverUrl: string, mycoHome: string): Map<string, RegistryEntry> {
  const bound = new Map<string, RegistryEntry>();
  for (const entry of listRegistryEntries(mycoHome)) {
    if (entry.serverUrl !== serverUrl) continue;
    if (entry.root === undefined) continue;
    bound.set(entry.root, entry);
  }
  return bound;
}

/** What the walk found, placed and counted. */
export interface CollectedCandidates {
  candidates: Candidate[];
  found: Record<string, number>;
  unattributable: number;
  unbound: number;
  unboundDirectories: Record<string, number>;
  active: number;
  dropped: number;
  excluded: number;
}

/**
 * The candidate a transcript file makes, or null when it is empty, gone, or
 * written too recently to be history. Written too recently is left for the
 * hook that is capturing it rather than imported and declared over.
 */
export function transcriptCandidate(
  agent: string, sessionId: string, filePath: string, root: string, machineId: string, now: number,
): Candidate | 'active' | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(filePath); } catch { return null; }
  if (!stat.isFile() || stat.size === 0) return null;
  if (now - stat.mtimeMs < IMPORT_ACTIVE_FLOOR_MS) return 'active';
  const pointer = transcriptPointerFor(filePath, machineId);
  if (pointer === null) return null;
  return {
    sessionId, transcriptId: pointer.transcriptId, agent, filePath,
    sizeBytes: stat.size, modifiedAt: Math.trunc(stat.mtimeMs), headHash: transcriptHeadHash(filePath), root,
  };
}

/** Whether live capture would drop this transcript's session: the agent's session rules, read against the transcript's own head. */
export function droppedByCaptureRules(agent: string, filePath: string): boolean {
  const transcriptMeta = readTranscriptMeta(filePath) ?? undefined;
  return evaluateSessionCaptureRules(agent, { transcriptPath: filePath, transcriptMeta }).action === 'drop';
}

/**
 * Every transcript on disk this machine can place, and the counts for what it
 * cannot.
 *
 * Attribution runs here rather than after the plan request, so a candidate is
 * never offered under a Project it does not belong to. A transcript live
 * capture would drop is dropped here too, and a session the caller excludes is
 * never offered.
 */
export function collectCandidates(
  agents: readonly string[], roots: Iterable<string>, machineId: string, mycoHome: string,
  now: number = Date.now(), opts: { mappings?: readonly DirectoryMapping[]; exclude?: ReadonlySet<string> } = {},
): CollectedCandidates {
  const place = transcriptPlacer(roots, { mappings: opts.mappings });
  const out: CollectedCandidates = { candidates: [], found: {}, unattributable: 0, unbound: 0, unboundDirectories: {}, active: 0, dropped: 0, excluded: 0 };

  for (const agent of agents) {
    const discovery = manifestTranscriptDiscovery(agent);
    if (discovery === undefined) continue;
    // Enumerated WHOLE, and trimmed only after the sort. A walk answers in
    // directory order, so a cap applied during it keeps whatever the
    // filesystem listed first — which on a real store is neither the newest
    // nor anything a person could predict.
    for (const discovered of enumerateTranscripts(discovery, ENUMERATION_CEILING)) {
      if (isMemberStatePath(discovered.filePath, mycoHome)) continue;
      out.found[agent] = (out.found[agent] ?? 0) + 1;
      if (opts.exclude?.has(discovered.sessionId)) { out.excluded += 1; continue; }
      const placed = place(agent, discovered.filePath);
      // Three outcomes, three counts. A transcript naming a directory this
      // Deployment holds no Project for is a different thing from one naming
      // nowhere, and only the first is something a person can connect.
      if (placed.kind === 'elsewhere') {
        out.unbound += 1;
        out.unboundDirectories[placed.directory] = (out.unboundDirectories[placed.directory] ?? 0) + 1;
        continue;
      }
      if (placed.kind === 'unknown') { out.unattributable += 1; continue; }
      if (droppedByCaptureRules(agent, discovered.filePath)) { out.dropped += 1; continue; }
      const candidate = transcriptCandidate(agent, discovered.sessionId, discovered.filePath, placed.root, machineId, now);
      if (candidate === 'active') { out.active += 1; continue; }
      if (candidate !== null) out.candidates.push(candidate);
    }
  }
  // Newest first: the plan spends the per-agent cap in the order it is
  // offered, so the most recent history is what an import brings.
  out.candidates.sort((a, b) => b.modifiedAt - a.modifiedAt);
  return out;
}

const emptyTally = (agent: string): AgentTally => ({ agent, found: 0, imported: 0, vanished: 0, trimmed: 0, skipped: {} });

const refusedReport = (refused: string): ImportReport =>
  ({ projects: [], unbound: 0, unattributable: 0, active: 0, dropped: 0, excluded: 0, unboundDirectories: {}, refused });

/**
 * Import one machine's history into every Project it can be placed in.
 *
 * Never called from a hook: a walk of every harness's store does not fit a
 * hook's budget, and nothing under `src/hooks/` reaches this module.
 */
export async function runImport(opts: ImportOptions, deps: ImportDeps): Promise<ImportReport> {
  const now = deps.now ?? Date.now;
  const mycoHome = deps.mycoHome ?? resolveMycoHome({ cwd: deps.cwd ?? process.cwd() });
  const fetchImpl = paced(deps.fetch ?? globalThis.fetch, deps.pace, deps.sleep ?? pause);

  const entries = listRegistryEntries(mycoHome);
  if (entries.length === 0) return refusedReport('no Deployment membership on this machine');

  // Which Deployment. Never the first entry: the registry is one file per
  // project root named by `sha256(root)`, so its order is a hash, and picking
  // from it imports into whichever Deployment that hash happened to sort
  // first — a machine joined to two would import nothing for the one it just
  // joined, and report every transcript as belonging to no Project.
  const deployments = [...new Set(entries.map((e) => e.serverUrl))];
  const named = opts.serverUrl ?? (deployments.length === 1 ? deployments[0] : deploymentForRoot(entries, deps.cwd));
  if (named === null) return refusedReport(`this machine belongs to ${deployments.length} Deployments; name one with --server`);
  const bound = bindingsFor(named, mycoHome);
  if (bound.size === 0) return refusedReport(`no project on this machine is bound to ${named}`);

  const agents = agentsWithStores(opts.agent);
  const exclude = new Set([...(opts.exclude ?? []), ...legacySessionsToLeaveOut(mycoHome, named)]);
  const collected = collectCandidates(agents, bound.keys(), deps.machineId, mycoHome, now(), { mappings: opts.mappings, exclude });
  const { candidates, unattributable, active } = collected;

  const byProject = new Map<string, Candidate[]>();
  // Projects this machine holds history for that `--project` excluded. Named
  // rather than dropped: "nothing to import" and "you asked for one of three"
  // are different answers.
  const narrowed = new Set<string>();
  let unbound = collected.unbound;
  for (const candidate of candidates) {
    const entry = bound.get(candidate.root);
    // A transcript that names a checkout this Deployment holds no Project for.
    // Counted rather than dropped: it is the difference between "your other
    // project is not connected here" and history vanishing without a word.
    if (entry === undefined) { unbound += 1; continue; }
    if (opts.project !== undefined && entry.projectId !== opts.project) { narrowed.add(entry.projectId); continue; }
    const list = byProject.get(entry.projectId);
    if (list === undefined) byProject.set(entry.projectId, [candidate]); else list.push(candidate);
  }

  const report: ImportReport = {
    projects: [], unbound, unattributable, active, dropped: collected.dropped, excluded: collected.excluded,
    unboundDirectories: collected.unboundDirectories, ...(narrowed.size > 0 ? { narrowed: [...narrowed].sort() } : {}),
  };
  for (const [projectId, forProject] of byProject) {
    if (opts.until !== undefined && now() >= opts.until) {
      report.projects.push({ projectId, root: '', agents: [], endedBy: IMPORT_DEADLINE });
      break;
    }
    const entry = [...bound.values()].find((e) => e.projectId === projectId);
    if (entry === undefined) continue;
    const tallies = new Map<string, AgentTally>();
    const tally = (agent: string): AgentTally => {
      const held = tallies.get(agent) ?? emptyTally(agent);
      tallies.set(agent, held);
      return held;
    };
    // Counted for THIS Project. A machine-wide figure here reads as this
    // Project's history and is wrong by however much the other Projects hold.
    for (const candidate of forProject) tally(candidate.agent).found += 1;

    // Newest first already, so the offer is the newest that fit and the trim
    // is the oldest. Reported per agent: a bound that silently drops the tail
    // is the same defect as an import that silently drops a Project.
    const limit = opts.offerLimit ?? IMPORT_PLAN_MAX_CANDIDATES;
    const offered = forProject.slice(0, limit);
    for (const candidate of forProject.slice(limit)) tally(candidate.agent).trimmed += 1;

    const client = new ServerClient(entry, fetchImpl);
    const answer = await client.importPlan({
      windowDays: opts.windowDays,
      maxPerAgent: opts.maxPerAgent,
      candidates: offered.map((c) => ({
        sessionId: c.sessionId, transcriptId: c.transcriptId, agent: c.agent,
        sizeBytes: c.sizeBytes, modifiedAt: c.modifiedAt, headHash: c.headHash,
      })),
    }, unboundedBudget());

    if (answer.class !== 'acked') {
      report.projects.push({ projectId, root: entry.root ?? '', agents: [...tallies.values()], endedBy: answer.class });
      continue;
    }

    const answers = Array.isArray(answer.body.candidates) ? answer.body.candidates as Array<Record<string, unknown>> : [];
    const decisions = new Map(answers.map((a) => [String(a.transcriptId), a]));
    const spool = new MemberSpool(projectId, { mycoHome });
    let endedBy: string | undefined;

    for (const candidate of offered) {
      const decision = decisions.get(candidate.transcriptId);
      const held = tally(candidate.agent);
      if (decision === undefined) continue;
      if (decision.take !== 'from') {
        const reason = String(decision.reason ?? 'skipped');
        held.skipped[reason] = (held.skipped[reason] ?? 0) + 1;
        continue;
      }
      if (opts.dryRun === true) { held.imported += 1; continue; }
      if (opts.until !== undefined && now() >= opts.until) { endedBy = IMPORT_DEADLINE; break; }

      const shipped = await shipSession(candidate, Number(decision.fromOffset ?? 0), client, spool, deps.machineId, now);
      if (shipped === 'done') { held.imported += 1; continue; }
      // Gone from the disk between the plan that admitted it and the ship that
      // would have read it. Nothing was sent, so it is not imported — and it is
      // not a refusal either, so the pass carries on to the next candidate.
      // Myco writes and prunes some of these stores, so this is ordinary.
      if (shipped === 'absent') { held.vanished += 1; continue; }
      // A refusal that ends one session ends the pass: the same policy the
      // drain applies, and for the same reason — a Deployment that refuses one
      // write refuses the next for the same cause.
      endedBy = shipped;
      break;
    }
    report.projects.push({ projectId, root: entry.root ?? '', agents: [...tallies.values()], ...(endedBy === undefined ? {} : { endedBy }) });
    if (endedBy !== undefined) break;
  }
  return report;
}

/**
 * One session: its facts, its bytes from the byte the Deployment named, and the
 * end that closes it. `facts: false` ships the bytes alone, for a caller that
 * sends the session's facts from a record of its own.
 */
export async function shipSession(
  candidate: Candidate, fromOffset: number, client: ServerClient, spool: MemberSpool, machineId: string, now: () => number,
  opts: { facts?: boolean } = {},
): Promise<string> {
  const { sessionId, filePath } = candidate;
  // Imported events are dated when the work happened, not when it was fetched:
  // the file's modification time is the only instant a member can know without
  // parsing, and parsing is the Deployment's half of transcript-first.
  const at = () => candidate.modifiedAt;
  const ctx: EnvelopeContext = { agent: candidate.agent, sessionId, stage: spool.stagerFor(sessionId), now: at, channel: 'import' };

  const pointer = transcriptPointerFor(filePath, machineId);
  if (pointer === null) return 'absent';

  // The session's facts once, not once per run. They are the same two events
  // every time — a deterministic id would collapse them server-side, but they
  // are minted, so a repeat is two more rows in the event log for a session
  // that has not changed. The receipt is the pointer this pass already commits:
  // a session whose transcript is known is a session whose facts were sent.
  const known = opts.facts === false || readSessionState(spool.dir, sessionId).transcript?.transcriptId === pointer.transcriptId;
  const facts = known ? [] : [
    sessionStartEvent(ctx, { startedAt: candidate.modifiedAt, originPath: filePath }),
    sessionEndEvent(ctx, { endedAt: candidate.modifiedAt }),
  ];
  // Committed with the pointer so a killed import leaves no receipt for an
  // event it never appended.
  spool.appendAndRecord(sessionId, facts, (state) => {
    state.agent ??= candidate.agent;
    state.transcript = { ...pointer, nextOffset: fromOffset };
  }, now());

  const drained = await spool.drainSession(sessionId, client, unboundedBudget(), { now, force: true });
  if (drained.endedBy !== 'drained') return drained.endedBy;

  const result = await shipTranscriptSegments(ctx, spool, client, unboundedBudget(), { now, headHash: candidate.headHash ?? undefined });
  return result.endedBy;
}

/** The longest one wait between passes lasts, whatever the Deployment asks. */
export const IMPORT_RETRY_MAX_WAIT_MS = 60_000;
/** The wait before the first retry when the Deployment names none; each later one doubles, up to the cap. */
export const IMPORT_RETRY_BASE_WAIT_MS = 2_000;
/** Passes an import makes before it reports the retry it could not get past. */
export const IMPORT_MAX_PASSES = 200;

/** The wait before pass `attempt` (1-based) of a retried import. */
export const retryWaitMs = (attempt: number): number =>
  Math.min(IMPORT_RETRY_MAX_WAIT_MS, IMPORT_RETRY_BASE_WAIT_MS * 2 ** Math.min(attempt - 1, 16));

/** Wait `ms` between import passes; a caller that must not wait passes its own. */
export const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The requests a minute an import run by hand stays under: two thirds of a credential's rate budget, the rest left to live capture. */
export const IMPORT_PACE_PER_MINUTE = 200;

/**
 * A fetch that starts at most `perMinute` requests a minute, one at a time,
 * spacing them evenly; `fetch` itself when `perMinute` is absent.
 */
export function paced(fetchImpl: FetchLike, perMinute: number | undefined, sleep: (ms: number) => Promise<void>, now: () => number = Date.now): FetchLike {
  if (perMinute === undefined || perMinute <= 0) return fetchImpl;
  const spacing = 60_000 / perMinute;
  let next = 0;
  return async (input, init) => {
    const at = now();
    if (next > at) await sleep(next - at);
    next = Math.max(now(), next) + spacing;
    return fetchImpl(input, init);
  };
}

/** The longest a step of an import waits out rate limits and unreachable Deployments, in all, before it is recorded as failed. */
export const IMPORT_WAIT_CAP_MS = 30 * 60_000;
/** HTTP statuses waited out however often they come: the rate limit, and a Deployment that asks to be retried. */
const WAIT_STATUSES: ReadonlySet<number> = new Set([429, 503]);

/**
 * What a retryable answer calls for, by the HTTP status it carried: `wait` for
 * a rate limit, a Deployment asking to be retried, or no answer at all (a
 * network fault); `fault` for any other server error, retried a few times;
 * `fail` for a status no retry changes (a request the Deployment rejects).
 */
export function retryVerdict(status: number | undefined): 'wait' | 'fault' | 'fail' {
  if (status === undefined || WAIT_STATUSES.has(status)) return 'wait';
  return status >= 500 ? 'fault' : 'fail';
}

/** A fetch that records the status of the last response it received, undefined for a request that got none. */
export function observedFetch(fetchImpl: FetchLike): { fetch: FetchLike; lastStatus: () => number | undefined } {
  let last: number | undefined;
  return {
    fetch: async (input, init) => {
      last = undefined;
      const res = await fetchImpl(input, init);
      last = res.status;
      return res;
    },
    lastStatus: () => last,
  };
}

/** Whether a pass stopped on an answer that a later pass can get past. */
export const endedOnRetry = (report: ImportReport): boolean => report.projects.some((p) => p.endedBy === 'retry');

/**
 * Run passes until none stops on a retryable answer, waiting between them.
 * Every pass re-plans from what the Deployment holds, so a session a pass
 * finished is not sent again and reads as already held in the next pass's
 * report. A rate limit or an unreachable Deployment is waited out for up to
 * `IMPORT_WAIT_CAP_MS` in all; another server error is retried a few times; a
 * status no retry changes stops at once. The last report is answered, with
 * `stoppedBy` naming why a pass still ended on a retryable answer.
 */
export async function importUntilSettled(
  opts: ImportOptions, deps: ImportDeps & { maxPasses?: number; onRetry?: (attempt: number, waitMs: number) => void },
): Promise<ImportReport> {
  const sleep = deps.sleep ?? pause;
  const maxPasses = deps.maxPasses ?? IMPORT_MAX_PASSES;
  const observed = observedFetch(deps.fetch ?? globalThis.fetch);
  const pass = () => runImport(opts, { ...deps, fetch: observed.fetch });
  let report = await pass();
  let waited = 0;
  let faults = 0;
  for (let attempt = 1; report.refused === undefined && endedOnRetry(report); attempt++) {
    const status = observed.lastStatus();
    const verdict = retryVerdict(status);
    if (verdict === 'fail') return { ...report, stoppedBy: `the Deployment answered ${status}` };
    if (verdict === 'fault' && ++faults > SERVER_FAULT_RETRIES) return { ...report, stoppedBy: `the Deployment kept failing (${status})` };
    const wait = retryWaitMs(verdict === 'fault' ? faults : attempt);
    if (attempt >= maxPasses || waited + wait > IMPORT_WAIT_CAP_MS) return { ...report, stoppedBy: 'the Deployment kept asking to wait' };
    deps.onRetry?.(attempt, wait);
    await sleep(wait);
    waited += wait;
    report = await pass();
  }
  return report;
}

/** Tries a step makes after the Deployment answers a server error before the step is recorded as failed. */
export const SERVER_FAULT_RETRIES = 3;
