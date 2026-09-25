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
 * acknowledged, the order the session's own hooks keep.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { BUNDLED_MANIFESTS } from '../symbionts/manifests.generated.js';
import { resolveTranscriptPath } from '../symbionts/transcript-discovery.js';
import { canStartRequest, unboundedBudget, type HookBudget } from './budget.js';
import { refreshDue, refreshMemberCredential } from './refresh.js';
import { readRegistryEntry, type RegistryEntry } from './registry.js';
import { readSessionState, type SessionState, type TranscriptPointer } from './session-state.js';
import { MemberSpool, type DrainEnd, type DrainOptions, type DrainResult } from './spool.js';
import { ensurePrivateFile } from './store.js';
import { shipSessionTranscripts, type ShipResult } from './transcript.js';
import { ServerClient, type FetchLike } from './transport.js';

/** Marks a spool whose session states have been read once for transcripts behind their files. */
export const BACKLOG_SCANNED_FILE = '.transcript-backlog-scanned';

export interface BacklogOptions extends DrainOptions {
  /** This machine's id, which a replaced transcript's fresh identity is minted under. */
  machineId: string;
  /** The session the caller delivers itself; the walk leaves it alone. */
  exclude?: string;
  /** Read every session state for transcripts behind their files, not only the sessions already marked. */
  rescan?: boolean;
}

export interface BacklogSession {
  sessionId: string;
  events?: DrainResult;
  /** The transcript pass; `no-agent` when no symbiont can be named for the session, `lease` when another process holds it. */
  transcripts?: ShipResult | 'no-agent' | 'lease';
}

export interface BacklogReport {
  sessions: BacklogSession[];
  /** Why the walk stopped: `done` when it reached every session. */
  endedBy: 'done' | 'budget' | DrainEnd | ShipResult['endedBy'];
}

/** Event pass endings that say nothing about the next session. Any other answer would be the next session's too, so the walk ends there: a mis-deployed server costs one request, not one per session. */
const EVENTS_CONTINUE: readonly DrainEnd[] = ['drained', 'acked', 'refused', 'reslice'];
/** Transcript pass endings that say nothing about the next session. */
const TRANSCRIPTS_CONTINUE: readonly ShipResult['endedBy'][] = ['done', 'absent', 'refused'];

const pointersOf = (state: SessionState): TranscriptPointer[] =>
  [...(state.transcript ? [state.transcript] : []), ...Object.values(state.siblings)];

const behind = (pointer: TranscriptPointer): boolean => {
  try {
    return fs.statSync(pointer.path).size > pointer.nextOffset;
  } catch {
    return false;
  }
};

/** Mark every session whose state holds a transcript pointer behind its file; returns how many were marked. */
export function markBehindTranscripts(spool: MemberSpool): number {
  let marked = 0;
  for (const sessionId of spool.stateSessionIds()) {
    if (!pointersOf(readSessionState(spool.dir, sessionId)).some(behind)) continue;
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
export function agentOfSession(sessionId: string, state: SessionState): string | null {
  if (state.agent !== undefined) return state.agent;
  const file = state.transcript?.path;
  if (file === undefined) return null;
  const target = path.resolve(file);
  const matches = BUNDLED_MANIFESTS.filter((manifest) => {
    const found = resolveTranscriptPath(manifest.capture?.transcriptDiscovery, sessionId);
    return found !== null && path.resolve(found) === target;
  });
  return matches.length === 1 ? matches[0].name : null;
}

/** Deliver the backlog inside `budget`, session by session, until it is delivered, the budget is spent, or an answer says the next session would fare no better. */
export async function drainBacklog(spool: MemberSpool, client: ServerClient, budget: HookBudget, opts: BacklogOptions): Promise<BacklogReport> {
  const now = opts.now ?? Date.now;
  const report: BacklogReport = { sessions: [], endedBy: 'done' };
  if (!budget.drains) return report;
  const scanned = path.join(spool.dir, BACKLOG_SCANNED_FILE);
  if (opts.rescan === true || !fs.existsSync(scanned)) {
    markBehindTranscripts(spool);
    ensurePrivateFile(scanned);
  }
  const spooled = new Set(spool.sessionIds());
  const ids = [...new Set([...spooled, ...spool.transcriptBacklogIds()])].filter((id) => id !== opts.exclude).sort();
  for (const sessionId of ids) {
    if (!canStartRequest(budget, now())) { report.endedBy = 'budget'; break; }
    const session: BacklogSession = { sessionId };
    report.sessions.push(session);
    if (spooled.has(sessionId)) {
      const events = await spool.drainSession(sessionId, client, budget, { force: opts.force, now, onUnauthorized: opts.onUnauthorized, clientFor: opts.clientFor });
      session.events = events;
      if (!EVENTS_CONTINUE.includes(events.endedBy)) { report.endedBy = events.endedBy; break; }
      if (events.remaining > 0) continue;
    }
    if (!spool.hasTranscriptBacklog(sessionId)) continue;
    const state = readSessionState(spool.dir, sessionId);
    // Every transcript acknowledged to its end, or gone from disk: nothing is left to deliver.
    if (!pointersOf(state).some(behind)) { spool.clearTranscriptBacklog(sessionId); continue; }
    const agent = agentOfSession(sessionId, state);
    if (agent === null) {
      // The bytes stay on disk; only the mark goes, so the walk stops paying for a session it cannot label.
      process.stderr.write(`[myco] member: session ${sessionId} names no symbiont for its transcript ${state.transcript?.path ?? '(none)'} — left undelivered\n`);
      spool.clearTranscriptBacklog(sessionId);
      session.transcripts = 'no-agent';
      continue;
    }
    const ctx = { agent, sessionId, stage: spool.stagerFor(sessionId), now };
    const shipped = await spool.withSessionLease(sessionId, () => shipSessionTranscripts(ctx, spool, client, budget, { now, machineId: opts.machineId }));
    session.transcripts = shipped ?? 'lease';
    if (shipped !== null && !TRANSCRIPTS_CONTINUE.includes(shipped.endedBy)) { report.endedBy = shipped.endedBy; break; }
  }
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
