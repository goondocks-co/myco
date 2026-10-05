/**
 * The project's backlog: what sessions other than the caller's captured and the
 * Deployment has not acknowledged — their spooled events, and the transcript
 * bytes past their pointers.
 *
 * A session's own hooks deliver that session's capture. A session that ended
 * while delivery was impossible — offline, a lapsed or replaced credential —
 * has no hook left to fire, so its records reach the Deployment only from here:
 * a probing hook of any session spends what its budget has left after its own
 * delivery on this walk, and `myco member drain` and `myco login` run it
 * unbounded.
 *
 * The walk is idempotent against the Deployment: an event is acknowledged by
 * id and a transcript segment by its offset, so a session another process is
 * delivering at the same moment is neither lost nor doubled. Each session's
 * events go first, and its transcripts ship only once they are all
 * acknowledged, the order the session's own hooks keep. A session whose events
 * or transcripts a transient refusal held is passed over until its wait runs
 * out; an explicit full pass sends them regardless.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { BUNDLED_MANIFESTS } from '../symbionts/manifests.generated.js';
import type { TranscriptDiscovery } from '../symbionts/manifest-schema.js';
import { sessionIdFromTranscriptPath } from '../symbionts/transcript-discovery.js';
import { canStartRequest, unboundedBudget, type HookBudget } from './budget.js';
import { clearNonRotatingRefusal, refreshDue, refreshMembership, rotatedCredential } from './refresh.js';
import { type RegistryEntry } from './registry.js';
import { recoverArchivedQuarantine } from './retention.js';
import { pointerBehind, pointersOf, readSessionState, retryWaiting, turnsFileOf, updateSessionState, type SessionState } from './session-state.js';
import { HOLD_ENDS, MemberSpool, turnEndIdentity, turnEndSatisfied, type DrainEnd, type DrainOptions, type DrainResult, type PendingTurnEnd } from './spool.js';
import { featureAdvertised } from './context-cache.js';
import { ensurePrivateFile, writePrivateFileAtomic } from './store.js';
import { shipSessionTranscripts, type ShipResult } from './transcript.js';
import { flushHeldCapture } from './held.js';
import { attemptHeldMigrationForCapture } from './pending.js';
import { migrateLegacySpool } from './spool-migration.js';
import { liveRoutingEntry } from './routing.js';
import { ServerClient, type FetchLike } from './transport.js';

/** Marks a spool whose session states have been read once for transcripts behind their files. */
export const BACKLOG_SCANNED_FILE = '.transcript-backlog-scanned';
/** The session the last walk ended on; the next walk starts after it. */
export const BACKLOG_CURSOR_FILE = '.backlog-cursor';

export interface BacklogOptions extends DrainOptions {
  /** This machine's id, which a replaced transcript's fresh identity is minted under. */
  machineId: string;
  /** The session the caller delivers itself; the walk leaves it alone. */
  exclude?: string;
  /** An explicit full pass: every session state read for transcripts behind their files, not only the sessions already marked, and every deferral after a transient refusal ignored. */
  rescan?: boolean;
  /** Walk the session written to last first (the member helper's walk): the one whose hook kicked it. */
  newestFirst?: boolean;
}

export interface BacklogSession {
  sessionId: string;
  events?: DrainResult;
  /** The transcript pass; `no-agent` when no symbiont can be named for the session, `lease` when another process holds it, `deferred` while a transient refusal's wait runs. */
  transcripts?: ShipResult | 'no-agent' | 'lease' | 'deferred';
}

export interface BacklogReport {
  sessions: BacklogSession[];
  /** Why the walk stopped: `done` when it reached every session and tried each one not waiting after a refusal; `skipped` when it passed one it could not try (latched, or held by another process). */
  endedBy: 'done' | 'skipped' | 'budget' | DrainEnd | ShipResult['endedBy'];
}

/** Event pass endings that belong to the session alone. Any other answer — unreachable, the credential refused, an older server's quota, the protocol window, the budget — would be the next session's too, so the walk ends there: a mis-deployed server costs one request, not one per session. */
const EVENTS_CONTINUE: readonly DrainEnd[] = ['drained', 'acked', 'reslice', 'protocol_mismatch', ...HOLD_ENDS];
/** Transcript pass endings that belong to the session alone. */
const TRANSCRIPTS_CONTINUE: readonly ShipResult['endedBy'][] = ['done', 'absent', 'refused', 'rejected', 'ordered', 'held'];

/**
 * How long a session goes without a hook before what its transcript holds past its last turn's end ships anyway: a
 * harness that ended without its session's end hook (killed, crashed) leaves no turn to wait for.
 */
export const TAIL_IDLE_MS = 15 * 60_000;

/**
 * Whether a session's transcript is to be held at its last turn-end mark: the Deployment is told of turn ends by the
 * transcript alone (it does not take `turn`), and the session is live, so the bytes past its last mark belong to a
 * turn under way. Once the session has ended, or its hooks have gone quiet, every byte ships.
 */
export function holdsTranscriptTail(spool: MemberSpool, state: SessionState, now: number, serverUrl: string, takesTurns = featureAdvertised({ serverUrl, projectId: spool.projectId }, spool.mycoHome, 'turn')): boolean {
  if (takesTurns) return false;
  if (state.endedAt !== undefined || state.hookAt === undefined) return false;
  return now - state.hookAt < TAIL_IDLE_MS;
}

/** Whether an event pass offered the session to the Deployment and got the session's own answer, rather than stopping on something every session would meet. */
export const sessionTried = (events: DrainResult): boolean => events.skipped === undefined && EVENTS_CONTINUE.includes(events.endedBy);

/** Whether an event pass ended holding a record of the session's own, which says nothing about any other session's. */
export const sessionHeld = (events: DrainResult): boolean => events.skipped === undefined && HOLD_ENDS.includes(events.endedBy);

/** The sessions in walk order: sorted, starting after the one the last walk ended on, so a session that holds a walk up cannot starve the ones after it. */
function walkOrder(spool: MemberSpool, ids: readonly string[], newestFirst: boolean): string[] {
  const sorted = [...ids].sort();
  let cursor: string | null = null;
  try { cursor = fs.readFileSync(path.join(spool.dir, BACKLOG_CURSOR_FILE), 'utf-8').trim() || null; } catch { /* no walk yet */ }
  const turned = cursor === null ? sorted : (() => {
    const start = sorted.findIndex((id) => id > cursor!);
    return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
  })();
  // The session written to last goes first: the one a person is working in, whose hook kicked this walk.
  const newest = newestFirst ? newestSession(spool, ids) : null;
  return newest === null ? turned : [newest, ...turned.filter((id) => id !== newest)];
}

/** The session whose journal or turn-end marks were appended to last: the one the latest hook wrote. */
function newestSession(spool: MemberSpool, ids: readonly string[]): string | null {
  const mtime = (file: string): number => { try { return fs.statSync(file).mtimeMs; } catch { return -1; } };
  let newest: string | null = null;
  let at = -1;
  for (const id of ids) {
    const written = Math.max(mtime(path.join(spool.dir, `${id}.jsonl`)), mtime(turnsFileOf(spool.dir, id)));
    if (written > at) { at = written; newest = id; }
  }
  return newest;
}

/** Mark every session whose state holds a transcript pointer behind its file; returns how many were marked. */
export function markBehindTranscripts(spool: MemberSpool): number {
  let marked = 0;
  for (const sessionId of spool.stateSessionIds()) {
    if (!pointersOf(readSessionState(spool.dir, sessionId)).some(pointerBehind)) continue;
    spool.markTranscriptBacklog(sessionId);
    marked += 1;
  }
  return marked;
}

/**
 * The symbiont a session's transcripts belong to: the one its state records,
 * or — for a state that records none — the one agent whose declared transcript
 * layout resolves this session id to exactly the file the state points at.
 * Null when no agent, or more than one, does.
 */
export function agentOfSession(
  sessionId: string, state: SessionState,
  manifests: ReadonlyArray<{ name: string; capture?: { transcriptDiscovery?: TranscriptDiscovery } }> = BUNDLED_MANIFESTS,
): string | null {
  if (state.agent !== undefined) return state.agent;
  const file = state.transcript?.path;
  if (file === undefined) return null;
  const target = path.resolve(file);
  const matches = manifests.filter((manifest) => {
    return sessionIdFromTranscriptPath(manifest.capture?.transcriptDiscovery, target) === sessionId;
  });
  return matches.length === 1 ? matches[0].name : null;
}

/**
 * The symbiont a session's transcripts are labelled with, found once and kept
 * in its state. A session no single symbiont can be named for is recorded as
 * such and reported, and is searched for again only when `retry` asks: the
 * search walks the agents' transcript stores, so a hook's walk runs it once
 * per session.
 */
function labelSession(spool: MemberSpool, sessionId: string, state: SessionState, retry: boolean): string | null {
  if (state.agent !== undefined) return state.agent;
  if (state.agentUnknown === true && !retry) return null;
  const agent = agentOfSession(sessionId, state);
  updateSessionState(spool.dir, sessionId, (next) => {
    if (next.agent !== undefined) return;
    if (agent === null) next.agentUnknown = true;
    else { next.agent = agent; delete next.agentUnknown; }
  });
  if (agent === null) process.stderr.write(`[myco] member: no one symbiont names the transcript ${state.transcript?.path ?? '(none)'} of session ${sessionId} — kept on this machine, undelivered\n`);
  return agent;
}

/**
 * What one hook appended to a session: the records it spooled, the turn-end mark it left (`turnEndIdentity`), and,
 * for a turn's or a session's end, how far the session's own transcript had reached when the hook read it.
 */
export interface HookAppended {
  eventIds: readonly string[];
  turnEnd?: string;
  transcriptTo?: { transcriptId: string; atSize: number };
}

/**
 * Whether what one hook appended has reached the Deployment: none of its records is still waiting in the session's
 * journal, and its turn-end mark has been consumed. What a hook that must deliver before it exits waits for: nothing
 * else the session holds (a subagent's transcript still growing, a transcript waiting out a refusal) is its to wait on.
 */
export function hookDelivered(spool: MemberSpool, sessionId: string, appended: HookAppended, now: number = Date.now()): boolean {
  if (appended.transcriptTo !== undefined && !transcriptReached(spool, sessionId, appended.transcriptTo, now)) return false;
  if (appended.turnEnd !== undefined && spool.pendingTurnEnds(sessionId).some((p) => turnEndIdentity(p.mark) === appended.turnEnd)) return false;
  if (appended.eventIds.length === 0) return true;
  const waiting = new Set(spool.readRecords(sessionId).slice(readSessionState(spool.dir, sessionId).highWater).flatMap((r) => (r === null ? [] : [r.eventId])));
  return !appended.eventIds.some((id) => waiting.has(id));
}

/**
 * Whether the session's own transcript has reached `to` on the Deployment, or has nothing left to wait for there: it
 * was replaced or refused for good, it is shorter than `to` names, or it is waiting out a refusal, which no wait inside
 * a hook outlasts.
 */
function transcriptReached(spool: MemberSpool, sessionId: string, to: { transcriptId: string; atSize: number }, now: number): boolean {
  const state = readSessionState(spool.dir, sessionId);
  const pointer = state.transcript;
  if (pointer === undefined || pointer.transcriptId !== to.transcriptId || pointer.refused !== undefined) return true;
  if (pointer.nextOffset >= to.atSize || retryWaiting(state.transcriptRetry, now)) return true;
  try { return fs.statSync(pointer.path).size < to.atSize; } catch { return true; }
}

/**
 * Consume the turn-end marks this pass read (`pending`) that have nothing left to wait for (`turnEndSatisfied`), oldest
 * first, up to the first that still waits: a mark is read in order, and one left behind keeps the ones after it. A
 * mark appended after the pass read them stays for the next pass, which ships to it.
 */
export function consumeSatisfiedTurnEnds(spool: MemberSpool, sessionId: string, pending: readonly PendingTurnEnd[]): void {
  if (pending.length === 0) return;
  const state = readSessionState(spool.dir, sessionId);
  let through: (typeof pending)[number] | undefined;
  for (const entry of pending) {
    if (!turnEndSatisfied(entry.mark, state)) break;
    through = entry;
  }
  if (through !== undefined) spool.consumeTurnEnds(sessionId, through);
}

/** Deliver the backlog inside `budget`, session by session, until it is delivered, the budget is spent, or an answer says the next session would fare no better. A session's own failure never ends the walk. */
export async function drainBacklog(spool: MemberSpool, client: ServerClient, budget: HookBudget, opts: BacklogOptions): Promise<BacklogReport> {
  spool.assertClientDestination(client);
  const now = opts.now ?? Date.now;
  const report: BacklogReport = { sessions: [], endedBy: 'done' };
  if (!budget.drains) return report;
  recoverArchivedQuarantine(spool, now(), () => canStartRequest(budget, now()));
  const scanned = path.join(spool.dir, BACKLOG_SCANNED_FILE);
  if (opts.rescan === true || !fs.existsSync(scanned)) {
    markBehindTranscripts(spool);
    ensurePrivateFile(scanned);
  }
  const spooled = new Set(spool.sessionIds());
  const ids = walkOrder(spool, [...new Set([...spooled, ...spool.transcriptBacklogIds()])].filter((id) => id !== opts.exclude), opts.newestFirst === true);
  let takesTurns: boolean | undefined;
  let skipped = false;
  for (const sessionId of ids) {
    if (!canStartRequest(budget, now())) { report.endedBy = 'budget'; break; }
    const session: BacklogSession = { sessionId };
    report.sessions.push(session);
    if (spooled.has(sessionId)) {
      const events = await spool.drainSession(sessionId, client, budget, {
        force: opts.force, now, onUnauthorized: opts.onUnauthorized, clientFor: opts.clientFor, honourRetry: opts.rescan !== true,
      });
      session.events = events;
      if (events.skipped === undefined) {
        if (!sessionTried(events)) { report.endedBy = events.endedBy; break; }
      } else if (events.skipped !== 'deferred') {
        skipped = true;
        continue;
      }
      // A held event holds its own lane only, through its wait as well: the session's transcripts still ship below,
      // once its start is delivered.
    }
    // The session's turn-end marks, read once: what this pass ships to, and all it may consume.
    const marks = spool.pendingTurnEnds(sessionId);
    if (!spool.hasTranscriptBacklog(sessionId)) { consumeSatisfiedTurnEnds(spool, sessionId, marks); continue; }
    const state = readSessionState(spool.dir, sessionId);
    // Every transcript acknowledged to its end, or gone from disk: nothing is left to deliver.
    if (!pointersOf(state).some(pointerBehind)) {
      spool.clearTranscriptBacklog(sessionId);
      consumeSatisfiedTurnEnds(spool, sessionId, marks);
      continue;
    }
    if (opts.rescan !== true && retryWaiting(state.transcriptRetry, now())) { session.transcripts = 'deferred'; continue; }
    const agent = labelSession(spool, sessionId, state, opts.rescan === true);
    if (agent === null) {
      // The bytes and the mark stay: the session is reported, and kept, until a symbiont can be named for it.
      session.transcripts = 'no-agent';
      continue;
    }
    const ctx = { agent, sessionId, stage: spool.stagerFor(sessionId), now };
    // A turn end the Deployment is told of by the transcript lane rides the segment that ends where it does.
    const turnEnds = marks.filter((p) => p.mark.slot === 'primary').map((p) => ({ transcriptId: p.mark.transcriptId, atSize: p.mark.atSize, at: p.mark.at }));
    takesTurns ??= featureAdvertised({ serverUrl: client.serverUrl, projectId: spool.projectId }, spool.mycoHome, 'turn');
    const holdTail = holdsTranscriptTail(spool, state, now(), client.serverUrl, takesTurns);
    const shipped = await spool.withSessionLease(sessionId, () => shipSessionTranscripts(ctx, spool, client, budget, { now, machineId: opts.machineId, turnEnds, holdTail }));
    consumeSatisfiedTurnEnds(spool, sessionId, marks);
    session.transcripts = shipped ?? 'lease';
    if (shipped === null) skipped = true;
    if (shipped !== null && !TRANSCRIPTS_CONTINUE.includes(shipped.endedBy)) { report.endedBy = shipped.endedBy; break; }
  }
  if (report.endedBy === 'done' && skipped) report.endedBy = 'skipped';
  const last = report.sessions.at(-1);
  if (last !== undefined) writePrivateFileAtomic(path.join(spool.dir, BACKLOG_CURSOR_FILE), last.sessionId);
  return report;
}

/**
 * A registry entry's whole backlog, unbounded, reading every session state
 * rather than only the marked ones: the credential renewed first when its
 * window is open, then every session delivered. What `myco member drain` and
 * `myco login` run.
 */
export async function drainEntryBacklog(
  entry: RegistryEntry,
  opts: {
    mycoHome: string; fetch?: FetchLike; now?: () => number; machineId?: string; budget?: HookBudget;
    credentialSource?: 'registry' | 'env';
    /** Inline hooks leave retained-journal migration for a detached helper or an explicit drain. */
    migrateLegacy?: boolean;
    /** Dial past the offline latch. True by default; the member helper does so only for a turn's or a session's end. */
    force?: boolean;
    /**
     * Read every session's state rather than only the marked ones, and send records again whatever wait a refusal
     * set. True by default, for a person's `myco member drain` and `myco login`; the member helper walks as a hook
     * does, forced or not.
     */
    rescan?: boolean;
    /** Walk the session written to last first. */
    newestFirst?: boolean;
  },
): Promise<BacklogReport> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const registryCredential = opts.credentialSource !== 'env';
  let current = entry;
  if (registryCredential && refreshDue(entry, now())) {
    await refreshMembership(entry.serverUrl, { mycoHome: opts.mycoHome, fetch: fetchImpl, now, budget: opts.budget ?? unboundedBudget(), projectId: entry.projectId });
    current = liveRoutingEntry(entry, opts.mycoHome);
  }
  const budget = opts.budget ?? unboundedBudget();
  if (current.root !== '') {
    attemptHeldMigrationForCapture(() => flushHeldCapture(current.root, current, { mycoHome: opts.mycoHome, now: now(), deadline: budget.deadline }));
  }
  const migration = opts.migrateLegacy === false ? null : attemptHeldMigrationForCapture(() => migrateLegacySpool(current, opts.mycoHome, now()));
  if (migration?.status === 'held') process.stderr.write(`[myco] member: legacy capture for ${current.projectId} held locally: ${migration.reason}\n`);
  for (const reason of migration?.sidecarHolds ?? []) process.stderr.write(`[myco] member: legacy optional state for ${current.projectId} held locally: ${reason}\n`);
  for (const file of migration?.ignoredSidecars ?? []) process.stderr.write(`[myco] member: legacy temporary artifact for ${current.projectId} ignored: ${file}\n`);
  const spool = new MemberSpool(current, { mycoHome: opts.mycoHome });
  const report = await drainBacklog(spool, new ServerClient(current, fetchImpl, { credentialSource: opts.credentialSource }), budget, {
    force: opts.force ?? true, now, machineId: opts.machineId ?? getMachineId(), rescan: opts.rescan ?? true, newestFirst: opts.newestFirst,
    // A 401 on a live send: another process may have rotated this root's token, so the registry is re-read and the
    // record retried once.
    onUnauthorized: registryCredential ? async () => rotatedCredential(current.root, current, opts.mycoHome) : undefined,
    clientFor: (record) => new ServerClient(record, fetchImpl, { credentialSource: opts.credentialSource }),
  });
  // A refused token is asked once whether it still rotates, so a refusal that is final is recorded and said.
  if (registryCredential && report.endedBy === 'unauthorized' && canStartRequest(budget, now())) {
    await refreshMembership(current.serverUrl, { mycoHome: opts.mycoHome, fetch: fetchImpl, now, budget, force: true, projectId: current.projectId });
  }
  // An acknowledged send is the Deployment accepting this token after all: a refusal recorded against it no longer holds.
  if (registryCredential && report.sessions.some((s) => (s.events?.acked ?? 0) > 0)) clearNonRotatingRefusal(current.serverUrl, current.token, opts.mycoHome, now);
  return report;
}
