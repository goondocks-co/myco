import { contextAdmission, type ContextAdmission } from '../db/context-records.js';
import { DOCUMENT_ID_FIELDS } from '../db/document-tables.js';
import { first, type Bound } from '../db/index.js';
import { kindIdentityCount, sessionChecks, type CaptureCheck, type SegmentAdmission } from '../db/capture/admission.js';
import { attachmentProjection } from '../db/capture/attachments.js';
import { planPrior, planProjections } from '../db/capture/plans.js';
import { importedTitle as importedTitleStatement, nameProjectFromStart, sessionCommit as sessionCommitStatement, sessionStartFacts, type Stored } from '../db/capture/sessions.js';
import { segmentProjections, segmentReads } from '../db/capture/transcripts.js';

import type { RelationalStore } from '../core/adapters.js';

import type { CaptureEnvelope } from './envelope.js';

import { type KindSpec, type Payload } from './kinds.js';

import { emit, refusal, type Refusal } from '../telemetry.js';

import { PROJECT_ARCHIVED } from './projects.js';

import { IMPORT_DISABLED } from '../core/import-policy.js';

import { presentedDatesAfterEvent, presentedDatesAfterSegment, settleSessionEnd, settleSessionTurn } from '../db/documents/lifecycle.js';

/** The identity of the write in flight: project, token, machine, the server clock, and the nonce that names this request's raw row. */
export interface WriteContext {
  projectId: string;
  tokenId: string;
  machineId: string;
  now: number;
  nonce: string;
  /** The member acting through a server-origin write, or null: what an applied end is attributed to. */
  actor: string | null;
  processing?: boolean;
}

/** A SQL fragment with its bound parameters. */
export interface Fragment {
  sql: string;
  params: unknown[];
}

/** Rows read in the same batch after the writes; the kind decides the response from them. */
export type ReadRows = Record<string, unknown>[][];

export interface KindPlan {
  /** The keys of the continued rows this kind names beyond its session, one per row the kind declares; each is admitted, read, and refused by the shared checks, in order. */
  identities: string[];
  /** What a transcript segment's raw insert additionally requires; absent for every other kind. */
  segment?: SegmentAdmission;
  /** Projection statements, every one gated on the raw row this request wrote (a kind's own precondition is conjoined with that gate, never substituted for it); each returns a row when it applied. */
  projections: Bound[];
  /** Same-batch reads placed ahead of the projections, so a kind sees the row it is about to move. */
  priors?: Bound<unknown, 'read'>[];
  /** Statements a kind runs beside its projections whose row change is not evidence that the kind's own projection applied. A conflict is decided from `projections` alone. */
  incidental?: Bound[];
  /** Same-batch reads that decide the response. */
  reads: Bound<unknown, 'read'>[];
  /** Runs once the event landed and its projections applied, with the prior reads' rows. */
  landed?(priors: ReadRows): void;
  /** The refusal for a request that stored no row and had no stored row, once the shared refusals have been ruled out. */
  refusal(rows: ReadRows): Refusal;
  /** True when a request that stored no row is a replay of a held segment (transcripts only). */
  heldDuplicate?(rows: ReadRows): boolean;
  /** The conflict text when the projections applied to no row although the event landed. */
  conflict?(rows: ReadRows): string;
  /** Extra response fields carried on every outcome. */
  extra?(rows: ReadRows): Record<string, unknown>;
}

const IDENTITY_MISMATCH: Refusal = refusal('machine identity mismatch', 'identity_mismatch');

const BLOB_ABSENT = (key: string): Refusal => refusal(`blob not present: ${key}`, 'blob_absent');

const NOT_STORED: Refusal = refusal('not stored');

/** A deleted session takes no further writes. The check sits on every kind's raw insert rather than in a handler, so it covers EVERY kind by construction: capture continues on a machine after a person deletes the session, and a sweep that only removed rows would be repopulated behind itself. */
const SESSION_TOMBSTONED: Refusal = refusal('session is deleted', 'session_tombstoned');

/**
 * The refusal a shared check's read explains, from its first row, or null when that check held. A continued row may
 * only be written, referenced, or continued by the machine that owns it; an absent row passes. A referenced blob must be
 * present and the writer's to name. An archived Project, a deleted session and an import the Deployment switched off
 * refuse every kind.
 */
export function checkRefusal(check: CaptureCheck, machineId: string, row: Record<string, unknown> | undefined): Refusal | null {
  switch (check.check) {
    case 'project': return row !== undefined && row.archived_at !== null ? refusal(PROJECT_ARCHIVED, 'project_archived') : null;
    case 'tombstone': return row === undefined ? null : SESSION_TOMBSTONED;
    case 'import': return row === undefined ? null : IMPORT_DISABLED;
    case 'owner': return row !== undefined && row.machine_id !== machineId ? IDENTITY_MISMATCH : null;
    case 'blob': return row === undefined ? BLOB_ABSENT(check.key) : null;
  }
}

const opt = <T>(v: T | undefined): T | null => (v === undefined ? null : v);

/** The instant an ordering is decided by: the payload's, or the envelope's caller time when the field is absent. The field must carry the catalogue's `time` bound, so an ordering can never be decided by a value the envelope's clock rule does not reach. */
const orderingTime = (spec: KindSpec, p: Payload, field: string, fallback: number): number => {
  const bound = spec.fields[field]?.bound;
  if (bound?.type !== 'time') throw new Error(`ordering field ${spec.name}.${field} must carry the time bound`);
  return (opt(p[field]) as number | null) ?? fallback;
};

interface Inputs {
  ctx: WriteContext;
  e: CaptureEnvelope;
  p: Payload;
  spec: KindSpec;
  /** sha256 of the inline text, or the blob key when spilled. */
  contentHash: string | null;
  envelopeHash?: string;
}

/** The request that stored the event, which every projection is gated on. */
const stored = (ctx: WriteContext, e: CaptureEnvelope): Stored => ({ project: ctx.projectId, session: e.sessionId, event: e.eventId, nonce: ctx.nonce });

/**
 * What a record naming a session, written outside an event, is admitted by: the same tombstone and session-ownership
 * checks every event is admitted by. `admission` sits on the write itself, so a session deleted or claimed while the
 * request composes takes no row; `refusal` reads why a write is held back, or null when it may land.
 * A session not yet held is writable, as a first event's is.
 */
export interface SessionWriteAdmission {
  admission: ContextAdmission;
  refusal(db: RelationalStore): Promise<Refusal | null>;
}

export function sessionWriteAdmission(
  ctx: Pick<WriteContext, 'projectId' | 'machineId'>,
  sessionId: string,
): SessionWriteAdmission {
  return {
    admission: contextAdmission(ctx.projectId, sessionId, ctx.machineId),
    async refusal(db) {
      for (const { check, read } of sessionChecks(ctx.projectId, sessionId)) {
        const refused = checkRefusal(check, ctx.machineId, (await first(db, read)) ?? undefined);
        if (refused !== null) return refused;
      }
      return null;
    },
  };
}

const rawOnly = (): KindPlan => ({
  identities: [],
  projections: [],
  reads: [],
  refusal: () => NOT_STORED,
});

/** The longest name a project takes from a path; the rename route's grammar. */
const MAX_PROJECT_NAME_CHARS = 200;

/** The last segment of a path, split on either separator; null when the path names nothing a person would call a project (`''`, `.`, `..`, the home shorthand `~`, or a segment longer than a name may be). */
export function basenameOf(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const segments = path
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
  const last = segments.length === 0 ? '' : segments[segments.length - 1];
  return acceptableProjectName(last);
}

/** A single display-name segment within the rename route's length bound. */
export function acceptableProjectName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  return name === '' ||
    name === '.' ||
    name === '..' ||
    name === '~' ||
    /[\\/]/.test(name) ||
    name.length > MAX_PROJECT_NAME_CHARS
    ? null
    : name;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** A session end row's observation error when the member could not read whether tracked files differed from the commit. */
export const GIT_STATUS_UNREADABLE = 'status_unreadable';

/**
 * The commit a session stood on, as the git provenance release reconciliation
 * reads: one row per session and capture point, with whether tracked files
 * differed from it. An end that does not say records `GIT_STATUS_UNREADABLE`
 * as its error rather than a clean worktree. The earliest start and the latest
 * end win, whole, so the rows converge in any delivery order; a value that is
 * not a full commit SHA writes nothing.
 */
const sessionCommit = (ctx: WriteContext, e: CaptureEnvelope, p: Payload, point: 'session_start' | 'session_end', at: number): Bound[] => {
  const headSha = typeof p.headSha === 'string' && COMMIT_SHA.test(p.headSha) ? p.headSha : null;
  if (headSha === null) return [];
  return [sessionCommitStatement(stored(ctx, e), {
    point, at, headSha, dirty: p.dirty === true, error: typeof p.dirty !== 'boolean' ? GIT_STATUS_UNREADABLE : null, now: ctx.now,
  })];
};

/** Session facts come from the earliest `session.start` in the total order (client time, then the smaller event id), so any delivery order converges — ties included: an event that ranks earlier than the one whose facts are held replaces every fact, an absent one included; a later one changes nothing. `started_at` is the minimum and `ended_at` the maximum of the events that carry them; identity columns (`machine_id`, `created_by_token_id`, `first_received_at`) stay with the first writer. A Project still named by its own id takes the repository name of the first start that carries one, falling back to its origin path's basename; a renamed or onboarded Project keeps its name. */
const sessionStart = ({ ctx, e, p, spec }: Inputs): KindPlan => {
  const startedAt = orderingTime(spec, p, 'startedAt', e.createdAt);
  const projectName = acceptableProjectName(p.projectName) ?? basenameOf(p.originPath);
  const at = stored(ctx, e);
  return {
    identities: [],
    projections: [
      sessionStartFacts(at, {
        startedAt, agent: p.agent as string, branch: opt(p.branch) as string | null, originPath: opt(p.originPath) as string | null,
        parentSessionId: opt(p.parentSessionId) as string | null, parentReason: opt(p.parentReason) as string | null,
        launchParentSessionId: opt(p.launchParentSessionId) as string | null,
      }),
      ...(projectName === null ? [] : [nameProjectFromStart(at, projectName)]),
      ...sessionCommit(ctx, e, p, 'session_start', startedAt),
    ],
    incidental: [presentedDatesAfterEvent(ctx.projectId, e.sessionId, lifecycleGate(ctx, e))],
    reads: [],
    refusal: () => NOT_STORED,
  };
};

/**
 * A session's lifecycle is decided from its keyed facts (`db/documents/lifecycle.ts`), which every lifecycle event
 * maintains in its own commit, so no decision reads the session's history. An end, on any channel, applies when it is the
 * winning end the facts hold and is not older than the newest human turn they name or the open turn the live document
 * published; a human prompt newer than the standing end reopens the session, by the stored turn, never the envelope of
 * the event that named it. An applied end records the acting member, or NULL for an agent's or an import's; a reopen
 * clears it.
 */
const lifecycleGate = (ctx: WriteContext, e: CaptureEnvelope) => ({ eventId: e.eventId, nonce: ctx.nonce });

/**
 * The title and summary an import end carries, stored as the session's one
 * titling attempt so neither automatic titling nor a backfill replaces them. A
 * title an administrator set or asked for (`titled_by`) is never replaced; an
 * end on any other channel carries none that is stored.
 */
const importedTitle = (ctx: WriteContext, e: CaptureEnvelope, p: Payload): Bound[] =>
  e.channel !== 'import' || typeof p.title !== 'string'
    ? []
    : [importedTitleStatement(stored(ctx, e), { title: p.title, summary: typeof p.summary === 'string' ? p.summary : null, now: ctx.now })];

/** An import end that names no instant and carries a title: it stores the title and nothing of the session's lifecycle. */
const titleOnly = (e: CaptureEnvelope, p: Payload): boolean =>
  e.channel === 'import' && p.endedAt === undefined && typeof p.title === 'string';

const sessionEnd = ({ ctx, e, p, spec }: Inputs): KindPlan => {
  if (titleOnly(e, p)) {
    return {
      identities: [],
      projections: importedTitle(ctx, e, p),
      reads: [],
      refusal: () => NOT_STORED,
    };
  }
  const endedAt = orderingTime(spec, p, 'endedAt', e.createdAt);
  const requestedAt = e.channel === 'import' ? null : endedAt;
  return {
    identities: [],
    projections: [
      settleSessionEnd({ project: ctx.projectId, session: e.sessionId, requestedAt, endedAt, actor: ctx.actor, gate: lifecycleGate(ctx, e) }),
      ...importedTitle(ctx, e, p),
      ...sessionCommit(ctx, e, p, 'session_end', endedAt),
    ],
    incidental: [presentedDatesAfterEvent(ctx.projectId, e.sessionId, lifecycleGate(ctx, e))],
    reads: [],
    refusal: () => NOT_STORED,
  };
};

const plan = ({ ctx, e, p, contentHash }: Inputs): KindPlan => {
  const planKey = p.planKey as string;
  const originPath = opt(p.originPath) as string | null;
  return {
    // A plan is a Project-shared editorial row: any member may update one, the
    // credential that did is recorded on it, and the creating session and machine
    // stay. The session the event names is still owned by the writing machine.
    identities: [],
    priors: [planPrior(ctx.projectId, planKey)],
    projections: planProjections(stored(ctx, e), {
      planKey, machine: ctx.machineId, title: opt(p.title) as string | null, content: opt(p.content) as string | null, blob: opt(p.blob) as string | null,
      contentHash, status: (opt(p.status) as string | null) ?? 'active', statusGiven: p.status !== undefined, originPath,
      source: opt(p.source) as string | null, promptId: opt(p.promptId) as string | null, createdAt: e.createdAt, token: ctx.tokenId, receivedAt: ctx.now,
      tags: (p.tags as string[] | undefined) ?? [],
    }),
    reads: [],
    refusal: () => NOT_STORED,
    conflict: () => 'plan did not apply',
    // New content arriving from another source than the row's: the signal an operator reads when two channels write one plan.
    landed: (priors) => {
      const prior = priors[0]?.[0] as
        | { content_hash: string; origin_path: string | null; updated_at: number }
        | undefined;
      if (prior === undefined || e.createdAt <= prior.updated_at) return;
      if (prior.content_hash !== contentHash && (prior.origin_path ?? null) !== originPath)
        emit({ kind: 'plan_overwritten', projectId: ctx.projectId, sessionId: e.sessionId, planKey });
    },
  };
};

const attachment = ({ ctx, e, p }: Inputs): KindPlan => ({
  identities: [p.attachmentId as string],
  projections: [attachmentProjection(stored(ctx, e), {
    attachmentId: p.attachmentId as string, promptId: opt(p.promptId) as string | null, description: opt(p.description) as string | null,
    originPath: opt(p.originPath) as string | null, createdAt: e.createdAt, token: ctx.tokenId, receivedAt: ctx.now, blob: p.blob as string,
  })],
  reads: [],
  refusal: () => NOT_STORED,
  conflict: () => 'attachment id already stored',
});

const transcriptSegment = ({ ctx, e, p }: Inputs): KindPlan => {
  const transcriptId = p.transcriptId as string;
  const baseOffset = p.baseOffset as number;
  const length = p.length as number;
  const blob = p.blob as string;
  // A transcript truncated and rewritten in place keeps its path and its inode, so the id alone cannot tell the new
  // file from the old one. A head digest that disagrees with the one held names a different file under a name already
  // taken, and is refused terminally rather than appended to. A rewrite that leaves the first bytes intact matches: the
  // digest catches truncation and replacement, not an edit in the middle. Absent `headHash` admits everything.
  const headHash = opt(p.headHash) as string | null;
  const owned = (rows: ReadRows): { size: number; segment_count: number } | null => {
    const transcript = rows[0]?.[0] as { size: number; segment_count: number; machine_id: string } | undefined;
    return transcript && transcript.machine_id === ctx.machineId ? transcript : null;
  };
  return {
    identities: [transcriptId],
    segment: { blob, length, transcriptId, baseOffset, headHash },
    // `imported_at` is the lane of the NEWEST segment; the prompt identity scheme is written by the insert alone,
    // admitted into its session's group of the agent's transcripts (`prompt-scheme.ts`).
    projections: segmentProjections(stored(ctx, e), {
      transcriptId, baseOffset, length, blob, headHash, agent: opt(p.agent) as string | null, originPath: opt(p.originPath) as string | null,
      role: (opt(p.role) as string | null) ?? 'primary', machine: ctx.machineId, token: ctx.tokenId, createdAt: e.createdAt, now: ctx.now,
      imported: e.channel === 'import',
    }),
    // A transcript that arrived on a live channel is no longer a backfill's:
    // the overlay is resolved with the segment's own write.
    incidental: [presentedDatesAfterSegment({ project: ctx.projectId, session: e.sessionId, gate: lifecycleGate(ctx, e), transcriptId, baseOffset })],
    reads: [...segmentReads(ctx.projectId, { transcriptId, baseOffset, blob })],
    refusal: (rows) => {
      const transcript = rows[0]?.[0] as { size: number; head_hash: string | null } | undefined;
      const blobRow = rows[2]?.[0] as { size: number } | undefined;
      if (blobRow !== undefined && blobRow.size !== length)
        return refusal('blob size does not match length', 'blob_length_mismatch');
      if (transcript?.head_hash != null && headHash !== null && transcript.head_hash !== headHash) {
        return refusal('transcript was replaced under the same identity', 'transcript_replaced');
      }
      const heldSize = transcript?.size ?? 0;
      if (baseOffset > heldSize) return refusal('transcript offset gap', 'offset_gap');
      return refusal('transcript offset overlap', 'offset_overlap');
    },
    heldDuplicate: (rows) => {
      if (owned(rows) === null) return false;
      const segment = rows[1]?.[0] as { blob_key: string; length: number } | undefined;
      return segment !== undefined && segment.blob_key === blob && segment.length === length;
    },
    conflict: () => 'transcript segment already stored',
    extra: (rows) => {
      const transcript = rows[0]?.[0] as { size: number; segment_count: number; machine_id: string } | undefined;
      if (transcript && transcript.machine_id !== ctx.machineId) return {};
      return { transcript: { size: transcript?.size ?? 0, segmentCount: transcript?.segment_count ?? 0 } };
    },
  };
};

const documentOnly = ({ ctx, e, p }: Inputs): KindPlan => ({
  ...rawOnly(),
  identities: [String(p[DOCUMENT_ID_FIELDS[e.kind]!])],
  incidental: e.kind !== 'prompt' ? [] : [
    presentedDatesAfterEvent(ctx.projectId, e.sessionId, lifecycleGate(ctx, e)),
    ...(p.origin !== 'user' ? [] : [settleSessionTurn(ctx.projectId, e.sessionId, lifecycleGate(ctx, e))]),
  ],
});

const PLANNERS: Record<KindSpec['projection'], (input: Inputs) => KindPlan> = {
  raw: rawOnly,
  sessions: (input) => (input.e.kind === 'session.start' ? sessionStart(input) : sessionEnd(input)),
  prompt_batches: documentOnly,
  tool_calls: documentOnly,
  responses: documentOnly,
  plans: plan,
  attachments: attachment,
  transcript_segments: transcriptSegment,
};

/** The projection plan for one validated event, naming as many continued rows as its kind declares. */
export function planKind(spec: KindSpec, input: Omit<Inputs, 'spec'>): KindPlan {
  const planned = PLANNERS[spec.projection]({ ...input, spec });
  if (planned.identities.length !== kindIdentityCount(spec)) throw new Error(`kind ${spec.name} declares ${kindIdentityCount(spec)} continued rows; its plan named ${planned.identities.length}`);
  return planned;
}
