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
import { resolveTranscriptPath } from '../symbionts/transcript-discovery.js';
import { canStartRequest, unboundedBudget, type HookBudget } from './budget.js';
import { refreshDue, refreshMemberCredential } from './refresh.js';
import { readRegistryEntry, type RegistryEntry } from './registry.js';
import { pointerBehind, pointersOf, readSessionState, retryWaiting, updateSessionState, type SessionState } from './session-state.js';
import { HOLD_ENDS, MemberSpool, type DrainEnd, type DrainOptions, type DrainResult } from './spool.js';
import { ensurePrivateFile, writePrivateFileAtomic } from './store.js';
import { shipSessionTranscripts, type ShipResult } from './transcript.js';
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
}

export interface BacklogSession {
  sessionId: string;
  events?: DrainResult;
  /** The transcript pass; `no-agent` when no symbiont can be named for the session, `lease` when another process holds it, `deferred` while a transient refusal's wait runs. */
  transcripts?: ShipResult | 'no-agent' | 'lease' | 'deferred';
}

export interface BacklogReport {
  sessions: BacklogSession[];
  /** The sessions whose spooled events this walk actually offered the Deployment and got a session's own answer to: the ones retention may judge stuck. */
  tried: string[];
  /** Why the walk stopped: `done` when it reached every session and tried each one not waiting after a refusal; `skipped` when it passed one it could not try (latched, or held by another process). */
  endedBy: 'done' | 'skipped' | 'budget' | DrainEnd | ShipResult['endedBy'];
}

/** Event pass endings that belong to the session alone. Any other answer — unreachable, the credential refused, an older server's quota, the protocol window, the budget — would be the next session's too, so the walk ends there: a mis-deployed server costs one request, not one per session. */
const EVENTS_CONTINUE: readonly DrainEnd[] = ['drained', 'acked', 'reslice', 'protocol_mismatch', ...HOLD_ENDS];
/** Transcript pass endings that belong to the session alone. */
const TRANSCRIPTS_CONTINUE: readonly ShipResult['endedBy'][] = ['done', 'absent', 'refused', 'rejected'];

/** Whether an event pass offered the session to the Deployment and got the session's own answer, rather than stopping on something every session would meet. */
export const sessionTried = (events: DrainResult): boolean => events.skipped === undefined && EVENTS_CONTINUE.includes(events.endedBy);

/** Whether an event pass ended holding a record of the session's own, which says nothing about any other session's. */
export const sessionHeld = (events: DrainResult): boolean => events.skipped === undefined && HOLD_ENDS.includes(events.endedBy);

/** The sessions in walk order: sorted, starting after the one the last walk ended on, so a session that holds a walk up cannot starve the ones after it. */
function walkOrder(spool: MemberSpool, ids: readonly string[]): string[] {
  const sorted = [...ids].sort();
  let cursor: string | null = null;
  try { cursor = fs.readFileSync(path.join(spool.dir, BACKLOG_CURSOR_FILE), 'utf-8').trim() || null; } catch { /* no walk yet */ }
  if (cursor === null) return sorted;
  const start = sorted.findIndex((id) => id > cursor!);
  return start <= 0 ? sorted : [...sorted.slice(start), ...sorted.slice(0, start)];
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
    const found = resolveTranscriptPath(manifest.capture?.transcriptDiscovery, sessionId);
    return found !== null && path.resolve(found) === target;
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

/** Deliver the backlog inside `budget`, session by session, until it is delivered, the budget is spent, or an answer says the next session would fare no better. A session's own failure never ends the walk. */
export async function drainBacklog(spool: MemberSpool, client: ServerClient, budget: HookBudget, opts: BacklogOptions): Promise<BacklogReport> {
  const now = opts.now ?? Date.now;
  const report: BacklogReport = { sessions: [], tried: [], endedBy: 'done' };
  if (!budget.drains) return report;
  const scanned = path.join(spool.dir, BACKLOG_SCANNED_FILE);
  if (opts.rescan === true || !fs.existsSync(scanned)) {
    markBehindTranscripts(spool);
    ensurePrivateFile(scanned);
  }
  const spooled = new Set(spool.sessionIds());
  const ids = walkOrder(spool, [...new Set([...spooled, ...spool.transcriptBacklogIds()])].filter((id) => id !== opts.exclude));
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
      if (events.skipped !== undefined) {
        if (events.skipped !== 'deferred') skipped = true;
        continue;
      }
      if (!sessionTried(events)) { report.endedBy = events.endedBy; break; }
      report.tried.push(sessionId);
      if (events.remaining > 0) continue;
    }
    if (!spool.hasTranscriptBacklog(sessionId)) continue;
    const state = readSessionState(spool.dir, sessionId);
    // Every transcript acknowledged to its end, or gone from disk: nothing is left to deliver.
    if (!pointersOf(state).some(pointerBehind)) { spool.clearTranscriptBacklog(sessionId); continue; }
    if (opts.rescan !== true && retryWaiting(state.transcriptRetry, now())) { session.transcripts = 'deferred'; continue; }
    const agent = labelSession(spool, sessionId, state, opts.rescan === true);
    if (agent === null) {
      // The bytes and the mark stay: the session is reported, and kept, until a symbiont can be named for it.
      session.transcripts = 'no-agent';
      continue;
    }
    const ctx = { agent, sessionId, stage: spool.stagerFor(sessionId), now };
    const shipped = await spool.withSessionLease(sessionId, () => shipSessionTranscripts(ctx, spool, client, budget, { now, machineId: opts.machineId }));
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
  entry: RegistryEntry, opts: { mycoHome: string; fetch?: FetchLike; now?: () => number; machineId?: string },
): Promise<BacklogReport> {
  const now = opts.now ?? Date.now;
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  let current = entry;
  if (refreshDue(entry, now())) {
    await refreshMemberCredential(entry.root, { mycoHome: opts.mycoHome, fetch: fetchImpl, now, budget: unboundedBudget() });
    current = readRegistryEntry(entry.root, opts.mycoHome) ?? entry;
  }
  const spool = new MemberSpool(current.projectId, { mycoHome: opts.mycoHome });
  return drainBacklog(spool, new ServerClient(current, fetchImpl), unboundedBudget(), { force: true, now, machineId: opts.machineId ?? getMachineId(), rescan: true });
}
