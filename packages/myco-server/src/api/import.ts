/**
 * What a member should ship when it imports its own disk.
 *
 * A member enumerating a harness's transcript store knows what is on the
 * machine and nothing about what the Deployment already has. Shipping first and
 * learning second is expensive in the one direction that matters: the segment
 * event is admitted only at the exact offset the Deployment holds, and the
 * bytes are uploaded BEFORE that event is posted — so a re-import from zero
 * stores and charges a blob, loses the event to an overlap refusal, and leaves
 * an object nothing references.
 *
 * So the member asks first. This answers, per candidate, whether to ship it and
 * from which byte, and the answer is the whole of what the member needs to know:
 * the bounds this Deployment sets, the sessions it refuses, the bytes it holds,
 * and whether the credential has room.
 *
 * **Nothing here is an authority.** Every rule it applies is applied again by
 * the admission the write path already carries — tenancy, tombstones, quota,
 * and the import switch — so a member that skipped this route writes exactly
 * what a member that used it would. It exists to stop bytes being spent on
 * writes that will be refused, not to decide whether they may be.
 *
 * Two of the three bounds cannot be re-derived from a single write. A window
 * and a per-harness count are properties of a whole pass, so they are applied
 * here and are cooperative; the switch is a property of the Deployment and is
 * an admission as well.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { IMPORT_PLAN_MAX_CANDIDATES } from '../constants.js';
import { importPolicy, IMPORT_DISABLED } from '../core/import-policy.js';
import { tombstonedAmong } from '../core/tombstones.js';
import { heldTranscriptsFor, type HeldTranscript } from '../read/transcript.js';
import { remainingQuotaBytes } from '../ingest/quota.js';
import { refused } from '../ingest/events.js';
import { emit, refusal } from '../telemetry.js';

const DAY_MS = 86_400_000;

/** Why a candidate is not being shipped. Each is a stable name an operator and a report read; none is a caller's text. Exported as a value so a reader can enumerate them rather than restate them. */
export const SKIP_REASONS = ['held', 'tombstoned', 'replaced', 'session_held', 'window', 'cap', 'quota'] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

/** What the member offers: an identity it minted, the file's size and age, and the digest of its first bytes. */
interface Candidate {
  sessionId: string;
  transcriptId: string;
  agent: string;
  sizeBytes: number;
  modifiedAt: number;
  headHash: string | null;
}

/** What a candidate is answered: the byte to start shipping at, or the named skip. */
export type CandidateAnswer =
  | { transcriptId: string; take: 'from'; fromOffset: number }
  | { transcriptId: string; take: 'none'; reason: SkipReason };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const BAD_BODY = refusal('body is not an object', 'parse');
const TOO_MANY = refusal(`candidates exceeds ${IMPORT_PLAN_MAX_CANDIDATES}`, 'body_cap');

const positiveInt = (v: unknown): number | undefined => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : undefined);

function parseCandidate(value: unknown): Candidate | null {
  if (!isRecord(value)) return null;
  const { sessionId, transcriptId, agent, sizeBytes, modifiedAt, headHash } = value;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (typeof transcriptId !== 'string' || transcriptId === '') return null;
  if (typeof agent !== 'string' || agent === '') return null;
  if (typeof sizeBytes !== 'number' || !Number.isInteger(sizeBytes) || sizeBytes < 0) return null;
  if (typeof modifiedAt !== 'number' || !Number.isInteger(modifiedAt)) return null;
  if (headHash !== undefined && headHash !== null && typeof headHash !== 'string') return null;
  return { sessionId, transcriptId, agent, sizeBytes, modifiedAt, headHash: typeof headHash === 'string' ? headHash : null };
}

/**
 * Every candidate's answer, in the order the member offered them.
 *
 * The order is the member's: it offers newest first, the quota is spent in
 * that order, and this walks the offer as given.
 */
function planCandidates(candidates: readonly Candidate[], held: readonly HeldTranscript[], tombstoned: ReadonlySet<string>, room: number, now: number, windowDays: number, maxPerAgent: number): {
  answers: CandidateAnswer[];
  counts: Record<string, number>;
  /** Candidates admitted against a held transcript that carries no digest to compare them with. */
  uncompared: number;
} {
  const byIdentity = new Map(held.map((h) => [h.transcriptId, h]));
  // A session's other primary transcripts, by session: what tells a file that
  // moved from a file that rotated.
  const primaries = new Map<string, HeldTranscript[]>();
  for (const h of held) {
    if (h.role !== 'primary') continue;
    const list = primaries.get(h.sessionId);
    if (list === undefined) primaries.set(h.sessionId, [h]); else list.push(h);
  }

  const cutoff = now - windowDays * DAY_MS;
  const answers: CandidateAnswer[] = [];
  const counts: Record<string, number> = {};
  const taken = new Map<string, number>();
  let left = room;
  let uncompared = 0;

  const skip = (c: Candidate, reason: SkipReason): void => {
    counts[reason] = (counts[reason] ?? 0) + 1;
    answers.push({ transcriptId: c.transcriptId, take: 'none', reason });
  };

  for (const c of candidates) {
    if (tombstoned.has(c.sessionId)) { skip(c, 'tombstoned'); continue; }
    if (c.modifiedAt < cutoff) { skip(c, 'window'); continue; }

    const mine = byIdentity.get(c.transcriptId);
    if (mine !== undefined) {
      // A held head digest that disagrees means the bytes behind this identity
      // were replaced; appending to that record would join one file's bytes to
      // another's. Holding MORE than the file has says the same thing.
      if (mine.headHash !== null && c.headHash !== null && mine.headHash !== c.headHash) { skip(c, 'replaced'); continue; }
      if (mine.size > c.sizeBytes) { skip(c, 'replaced'); continue; }
      if (mine.size === c.sizeBytes) { skip(c, 'held'); continue; }
    } else {
      // A different identity for a session already held is either the same file
      // under a new name — same first bytes, and re-deriving it would double
      // every row it holds — or a rotation, which is history worth importing.
      // Only the digest tells them apart, so only an equal digest refuses.
      const others = primaries.get(c.sessionId) ?? [];
      if (others.some((h) => h.headHash !== null && c.headHash !== null && h.headHash === c.headHash)) { skip(c, 'session_held'); continue; }
      // A held transcript carrying no digest cannot be compared, so this is
      // admitted and the pair is counted: shipping it may re-derive rows the
      // held one already produced, and refusing it would drop a rotation.
      // Every transcript an import ships carries a digest, so this closes as
      // the live path starts sending one.
      uncompared += others.filter((h) => h.headHash === null).length;
    }

    const count = taken.get(c.agent) ?? 0;
    if (count >= maxPerAgent) { skip(c, 'cap'); continue; }

    const fromOffset = mine?.size ?? 0;
    const owed = c.sizeBytes - fromOffset;
    // Whole or not at all: a transcript is the unit that must not be half
    // imported, and a later smaller one may still fit the room this one does
    // not.
    if (owed > left) { skip(c, 'quota'); continue; }

    left -= owed;
    taken.set(c.agent, count + 1);
    counts.take = (counts.take ?? 0) + 1;
    answers.push({ transcriptId: c.transcriptId, take: 'from', fromOffset });
  }
  return { answers, counts, uncompared };
}

export async function handleImportPlan(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(ctx.body); } catch { return Response.json(refused(ctx, BAD_BODY)); }
  if (!isRecord(body)) return Response.json(refused(ctx, BAD_BODY));

  const offered = Array.isArray(body.candidates) ? body.candidates : null;
  if (offered === null) return Response.json(refused(ctx, BAD_BODY));
  if (offered.length > IMPORT_PLAN_MAX_CANDIDATES) return Response.json(refused(ctx, TOO_MANY));
  const candidates: Candidate[] = [];
  for (const value of offered) {
    const parsed = parseCandidate(value);
    if (parsed === null) return Response.json(refused(ctx, BAD_BODY));
    candidates.push(parsed);
  }

  const policy = await importPolicy(env.db, { windowDays: positiveInt(body.windowDays), maxPerAgent: positiveInt(body.maxPerAgent) });
  if (!policy.enabled) {
    emit({ kind: 'import_plan_refused', projectId: ctx.projectId, reason: 'import_disabled' });
    return Response.json(refused(ctx, IMPORT_DISABLED));
  }
  if (candidates.length === 0) return Response.json({ persisted: true, policy, candidates: [] });

  const sessionIds = [...new Set(candidates.map((c) => c.sessionId))];
  const identities = [...new Set(candidates.map((c) => c.transcriptId))];

  // Each read through the module that owns its table: the transcripts a Project
  // holds, the sessions it has deleted, and the room the credential has left —
  // that last through the same expression every quota admission reads, so what
  // a caller is told it may spend is what the write path will admit.
  const held = await heldTranscriptsFor(env.db, { projectId: ctx.projectId }, sessionIds, identities);
  const tombstoned = await tombstonedAmong(env.db, ctx.projectId, sessionIds);
  const room = await remainingQuotaBytes(env.db, { tokenId: ctx.tokenId, now: ctx.now });

  const { answers, counts, uncompared } = planCandidates(candidates, held, tombstoned, room, ctx.now, policy.windowDays, policy.maxPerAgent);
  emit({ kind: 'import_planned', projectId: ctx.projectId, offered: candidates.length, admitted: counts.take ?? 0 });
  if (uncompared > 0) emit({ kind: 'import_identity_uncompared', projectId: ctx.projectId, pairs: uncompared });
  return Response.json({ persisted: true, policy, candidates: answers, counts });
}
