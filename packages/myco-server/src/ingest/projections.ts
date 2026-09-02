import type { RelationalStore, PreparedStatement } from '../core/adapters.js';
import type { CaptureEnvelope } from './envelope.js';
import { blobFields, promptReferenceFields, type KindSpec, type Payload } from './kinds.js';
import { emit, refusal, type Refusal } from '../telemetry.js';
import { PROJECT_ARCHIVED } from './projects.js';

/** The identity of the write in flight: project, token, machine, the server clock, and the nonce that names this request's raw row. */
export interface WriteContext {
  projectId: string;
  tokenId: string;
  machineId: string;
  now: number;
  nonce: string;
}

/** A SQL fragment with its bound parameters. */
export interface Fragment {
  sql: string;
  params: unknown[];
}

/** Rows read in the same batch after the writes; the kind decides the response from them. */
export type ReadRows = Record<string, unknown>[][];

/** A continued row a kind writes under a member-minted key, and how its owning machine is read: `row` when the table carries `machine_id` itself, `session` when ownership runs through the row's session. */
export interface Identity {
  table: string;
  keyColumn: string;
  key: string;
  owner: 'row' | 'session';
}

export interface KindPlan {
  /** The continued rows this kind names beyond its session; each is admitted, read, and refused by the shared checks, in identity order. */
  identities: Identity[];
  /** Preconditions placed on the raw insert beyond the shared ones (identities, blob presence, prompt ownership); all must hold for the event to be stored. */
  admission: Fragment[];
  /** Projection statements, every one gated on the raw row this request wrote (a kind's own precondition is conjoined with that gate, never substituted for it); each reports its own row change. */
  projections: PreparedStatement[];
  /** Same-batch reads placed ahead of the projections, so a kind sees the row it is about to move. */
  priors?: PreparedStatement[];
  /** Same-batch reads that decide the response. */
  reads: PreparedStatement[];
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

/** The raw row this request wrote, named by its nonce; a duplicate or conflict written by another request never matches. */
export const RAW_ROW_GATE = 'EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)';
export const rawGateParams = (ctx: WriteContext, e: CaptureEnvelope): unknown[] => [ctx.projectId, e.eventId, ctx.nonce];

export const IDENTITY_MISMATCH: Refusal = refusal('machine identity mismatch', 'identity_mismatch');
export const BLOB_ABSENT = (key: string): Refusal => refusal(`blob not present: ${key}`, 'blob_absent');
const NOT_STORED: Refusal = refusal('not stored');

/** One shared precondition: the admission fragment the raw insert carries, the same-batch read that explains a refusal, and the refusal decided from that read's first row. */
export interface SharedCheck {
  admission: Fragment;
  read: Fragment;
  refusal(row: Record<string, unknown> | undefined): Refusal | null;
}

/** A continued row may only be written, referenced, or continued by the machine that owns it — the row's own `machine_id`, or its session's; an absent row passes, so a first write and a reference to a not-yet-stored row are always admitted. The admission, the read, and the refusal are three views of this one predicate. */
const owned = (ctx: WriteContext, { table, keyColumn, key, owner }: Identity): SharedCheck => {
  const params = [ctx.projectId, key];
  const [admission, read] = owner === 'row'
    ? [`NOT EXISTS (SELECT 1 FROM ${table} WHERE project_id = ? AND ${keyColumn} = ? AND machine_id IS NOT ?)`,
       `SELECT machine_id FROM ${table} WHERE project_id = ? AND ${keyColumn} = ?`]
    : [`NOT EXISTS (SELECT 1 FROM ${table} x JOIN sessions s ON s.project_id = x.project_id AND s.session_id = x.session_id
          WHERE x.project_id = ? AND x.${keyColumn} = ? AND s.machine_id IS NOT ?)`,
       `SELECT s.machine_id FROM ${table} x JOIN sessions s ON s.project_id = x.project_id AND s.session_id = x.session_id WHERE x.project_id = ? AND x.${keyColumn} = ?`];
  return {
    admission: { sql: admission, params: [...params, ctx.machineId] },
    read: { sql: read, params },
    refusal: (row) => (row !== undefined && row.machine_id !== ctx.machineId ? IDENTITY_MISMATCH : null),
  };
};

/** The blob under `key` exists in this project. Media type is metadata recorded by the first uploader, never an admission gate. */
const present = (ctx: WriteContext, key: string): SharedCheck => ({
  admission: { sql: `EXISTS (SELECT 1 FROM blobs WHERE project_id = ? AND key = ?)`, params: [ctx.projectId, key] },
  read: { sql: `SELECT media_type FROM blobs WHERE project_id = ? AND key = ?`, params: [ctx.projectId, key] },
  refusal: (row) => (row === undefined ? BLOB_ABSENT(key) : null),
});

const opt = <T>(v: T | undefined): T | null => (v === undefined ? null : v);
/** The instant an ordering is decided by: the payload's, or the envelope's caller time when the field is absent. The field must carry the catalogue's `time` bound, so an ordering can never be decided by a value the envelope's clock rule does not reach. */
const orderingTime = (spec: KindSpec, p: Payload, field: string, fallback: number): number => {
  const bound = spec.fields[field]?.bound;
  if (bound?.type !== 'time') throw new Error(`ordering field ${spec.name}.${field} must carry the time bound`);
  return (opt(p[field]) as number | null) ?? fallback;
};
const bool = (v: unknown): number => (v === true ? 1 : 0);
const json = (v: unknown): string | null => (v === undefined ? null : JSON.stringify(v));

interface Inputs {
  db: RelationalStore;
  ctx: WriteContext;
  e: CaptureEnvelope;
  p: Payload;
  spec: KindSpec;
  /** sha256 of the inline text, or the blob key when spilled. */
  contentHash: string | null;
}

/** A capture lands only in a live Project: an archived one refuses every event, whatever route carried it. The admission fragment sits on the raw insert; the read tells an archived Project from an absent row. */
export const projectLive = (ctx: WriteContext): SharedCheck => ({
  admission: { sql: `EXISTS (SELECT 1 FROM projects WHERE project_id = ? AND archived_at IS NULL)`, params: [ctx.projectId] },
  read: { sql: `SELECT archived_at FROM projects WHERE project_id = ?`, params: [ctx.projectId] },
  refusal: (row) => (row !== undefined && row.archived_at !== null ? refusal(PROJECT_ARCHIVED, 'project_archived') : null),
});

/** The checks every kind shares, derived from the catalogue and the kind's declared identities in the one order they are admitted, read, and refused: the session's machine, then every continued row the kind names, then every referenced blob present, then every referenced prompt absent or owned by this machine. */
export function sharedChecks(spec: KindSpec, ctx: WriteContext, e: CaptureEnvelope, p: Payload, identities: Identity[]): SharedCheck[] {
  const named = (fields: string[]) => fields.filter((field) => typeof p[field] === 'string').map((field) => p[field] as string);
  return [
    owned(ctx, { table: 'sessions', keyColumn: 'session_id', key: e.sessionId, owner: 'row' }),
    ...identities.map((identity) => owned(ctx, identity)),
    ...named(blobFields(spec)).map((key) => present(ctx, key)),
    ...named(promptReferenceFields(spec)).map((promptId) => owned(ctx, { table: 'prompt_batches', keyColumn: 'prompt_id', key: promptId, owner: 'session' })),
  ];
}

const rawOnly = (): KindPlan => ({ identities: [], admission: [], projections: [], reads: [], refusal: () => NOT_STORED });

/** The longest name a project takes from a path; the rename route's grammar. */
export const MAX_PROJECT_NAME_CHARS = 200;

/** The last segment of a path, split on either separator; null when the path names nothing a person would call a project (`''`, `.`, `..`, the home shorthand `~`, or a segment longer than a name may be). */
export function basenameOf(path: unknown): string | null {
  if (typeof path !== 'string') return null;
  const segments = path.split(/[\\/]+/).map((s) => s.trim()).filter((s) => s !== '');
  const last = segments.length === 0 ? '' : segments[segments.length - 1];
  return last === '' || last === '.' || last === '..' || last === '~' || last.length > MAX_PROJECT_NAME_CHARS ? null : last;
}

/** Session facts come from the earliest `session.start` in the total order (client time, then the smaller event id), so any delivery order converges — ties included: an event that ranks earlier than the one whose facts are held replaces every fact, an absent one included; a later one changes nothing. `started_at` is the minimum and `ended_at` the maximum of the events that carry them; identity columns (`machine_id`, `created_by_token_id`, `first_received_at`) stay with the first writer. A Project still named by its own id takes the basename of the first start that carries a usable origin path; a renamed or onboarded Project keeps its name. */
const sessionStart = ({ db, ctx, e, p, spec }: Inputs): KindPlan => {
  const startedAt = orderingTime(spec, p, 'startedAt', e.createdAt);
  const projectName = basenameOf(p.originPath);
  const nameProject = projectName === null ? [] : [
    db.prepare(`UPDATE projects SET name = ? WHERE project_id = ? AND name = project_id AND ${RAW_ROW_GATE}`)
      .bind(projectName, ctx.projectId, ...rawGateParams(ctx, e)),
  ];
  const earlier = 'started_at IS NULL OR ? < started_at OR (? = started_at AND (facts_event_id IS NULL OR ? < facts_event_id))';
  const rank = [startedAt, startedAt, e.eventId];
  /** A fact is the earliest event's, whether it carries the field or not; a later event leaves it alone. */
  const fact = (column: string) => `${column} = CASE WHEN ${earlier} THEN ? ELSE ${column} END`;
  return {
    identities: [],
    admission: [],
    projections: [
      db.prepare(`UPDATE sessions
          SET ${fact('agent')},
              ${fact('branch')},
              ${fact('origin_path')},
              ${fact('parent_session_id')},
              ${fact('parent_reason')},
              ${fact('facts_event_id')},
              ${fact('started_at')}
        WHERE project_id = ? AND session_id = ? AND ${RAW_ROW_GATE}`)
        .bind(...rank, p.agent,
              ...rank, opt(p.branch),
              ...rank, opt(p.originPath),
              ...rank, opt(p.parentSessionId),
              ...rank, opt(p.parentReason),
              ...rank, e.eventId,
              ...rank, startedAt,
              ctx.projectId, e.sessionId, ...rawGateParams(ctx, e)),
      ...nameProject,
    ],
    reads: [],
    refusal: () => NOT_STORED,
  };
};

const sessionEnd = ({ db, ctx, e, p, spec }: Inputs): KindPlan => {
  const endedAt = orderingTime(spec, p, 'endedAt', e.createdAt);
  return {
    identities: [],
    admission: [],
    projections: [
      db.prepare(`UPDATE sessions SET ended_at = CASE WHEN ended_at IS NULL OR ? > ended_at THEN ? ELSE ended_at END
        WHERE project_id = ? AND session_id = ? AND ${RAW_ROW_GATE}`)
        .bind(endedAt, endedAt, ctx.projectId, e.sessionId, ...rawGateParams(ctx, e)),
    ],
    reads: [],
    refusal: () => NOT_STORED,
  };
};

/** A prompt row: inserted once, then merged by events that rank higher in the total order (client time, then the smaller event id, so ties are decided the same way in any delivery order) — the highest-ranked event supplies every merged column, an absent field included, so no other event fills one; `ended_at` comes from the earliest response of the same machine, so a response another machine posted before the prompt existed never sets it. */
const prompt = ({ db, ctx, e, p, contentHash }: Inputs): KindPlan => {
  const blob = p.blob as string | undefined;
  const newer = '(excluded.updated_at > prompt_batches.updated_at OR (excluded.updated_at = prompt_batches.updated_at AND excluded.event_id < prompt_batches.event_id))';
  return {
    identities: [],
    admission: [],
    projections: [
      db.prepare(`INSERT INTO prompt_batches
          (project_id, prompt_id, session_id, event_id, parent_prompt_id, thread_id, thread_label, origin, prompt_kind, text, blob_key, content_hash, created_at, updated_at, ended_at, token_id, received_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               (SELECT MIN(r.created_at) FROM responses r JOIN sessions s ON s.project_id = r.project_id AND s.session_id = r.session_id
                 WHERE r.project_id = ? AND r.prompt_id = ? AND s.machine_id IS ?), ?, ?
         WHERE ${RAW_ROW_GATE}
        ON CONFLICT (project_id, prompt_id) DO UPDATE SET
          prompt_kind = CASE WHEN ${newer} THEN excluded.prompt_kind ELSE prompt_batches.prompt_kind END,
          parent_prompt_id = CASE WHEN ${newer} THEN excluded.parent_prompt_id ELSE prompt_batches.parent_prompt_id END,
          thread_id = CASE WHEN ${newer} THEN excluded.thread_id ELSE prompt_batches.thread_id END,
          thread_label = CASE WHEN ${newer} THEN excluded.thread_label ELSE prompt_batches.thread_label END,
          event_id = CASE WHEN ${newer} THEN excluded.event_id ELSE prompt_batches.event_id END,
          ended_at = COALESCE(prompt_batches.ended_at, excluded.ended_at),
          created_at = MIN(prompt_batches.created_at, excluded.created_at),
          updated_at = MAX(prompt_batches.updated_at, excluded.updated_at)
        WHERE excluded.content_hash = prompt_batches.content_hash`)
        .bind(ctx.projectId, p.promptId, e.sessionId, e.eventId, opt(p.parentPromptId), opt(p.threadId), opt(p.threadLabel), p.origin, opt(p.promptKind),
              opt(p.text), opt(blob), contentHash, e.createdAt, e.createdAt, ctx.projectId, p.promptId, ctx.machineId, ctx.tokenId, ctx.now,
              ...rawGateParams(ctx, e)),
    ],
    reads: [db.prepare(`SELECT content_hash FROM prompt_batches WHERE project_id = ? AND prompt_id = ?`).bind(ctx.projectId, p.promptId)],
    refusal: () => NOT_STORED,
    conflict: (rows) => {
      const row = rows[0]?.[0] as { content_hash: string } | undefined;
      if (row && row.content_hash !== contentHash) return 'prompt text differs from the stored prompt';
      return 'prompt did not apply';
    },
  };
};

const toolCall = ({ db, ctx, e, p }: Inputs): KindPlan => {
  const inputBlob = p.blob as string | undefined;
  const outputBlob = p.outputBlob as string | undefined;
  return {
    identities: [{ table: 'tool_calls', keyColumn: 'tool_call_id', key: p.toolCallId as string, owner: 'session' }],
    admission: [],
    projections: [
      db.prepare(`INSERT INTO tool_calls
          (project_id, tool_call_id, session_id, prompt_id, event_id, tool_name, myco_tool, myco_op, input, input_blob_key, output_preview, output_blob_key, success, error_message, duration_ms, files_affected, canopy_injection_tokens, created_at, token_id, received_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${RAW_ROW_GATE}
        ON CONFLICT (project_id, tool_call_id) DO NOTHING`)
        .bind(ctx.projectId, p.toolCallId, e.sessionId, opt(p.promptId), e.eventId, p.toolName, opt(p.mycoTool), opt(p.mycoOp),
              json(p.input), opt(inputBlob), opt(p.output), opt(outputBlob), e.kind === 'tool.failure' ? 0 : bool(p.success), opt(p.errorMessage),
              opt(p.durationMs), json(p.filesAffected), opt(p.canopyInjectionTokens), e.createdAt, ctx.tokenId, ctx.now, ...rawGateParams(ctx, e)),
    ],
    reads: [],
    refusal: () => NOT_STORED,
    conflict: () => 'tool call id already stored',
  };
};

/** A response row, then the prompt's `ended_at` recomputed as the earliest response of the owning machine held after this write, so any delivery order converges. */
const response = ({ db, ctx, e, p, contentHash }: Inputs): KindPlan => {
  const blob = p.blob as string | undefined;
  const projections = [
    db.prepare(`INSERT INTO responses (project_id, response_id, session_id, prompt_id, event_id, text, blob_key, content_hash, created_at, token_id, received_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE ${RAW_ROW_GATE}
        ON CONFLICT (project_id, response_id) DO NOTHING`)
      .bind(ctx.projectId, p.responseId, e.sessionId, opt(p.promptId), e.eventId, opt(p.text), opt(blob), contentHash, e.createdAt, ctx.tokenId, ctx.now, ...rawGateParams(ctx, e)),
  ];
  if (p.promptId !== undefined) {
    projections.push(
      db.prepare(`UPDATE prompt_batches
          SET ended_at = (SELECT MIN(r.created_at) FROM responses r JOIN sessions s ON s.project_id = r.project_id AND s.session_id = r.session_id
                           WHERE r.project_id = ? AND r.prompt_id = ? AND s.machine_id IS ?)
        WHERE project_id = ? AND prompt_id = ? AND ${RAW_ROW_GATE}`)
        .bind(ctx.projectId, p.promptId, ctx.machineId, ctx.projectId, p.promptId, ...rawGateParams(ctx, e)),
    );
  }
  return { identities: [{ table: 'responses', keyColumn: 'response_id', key: p.responseId as string, owner: 'session' }], admission: [], projections, reads: [], refusal: () => NOT_STORED, conflict: () => 'response id already stored' };
};

const plan = ({ db, ctx, e, p, contentHash }: Inputs): KindPlan => {
  const planKey = p.planKey as string;
  const tags = JSON.stringify((p.tags as string[] | undefined) ?? []);
  const statusGiven = p.status === undefined ? 0 : 1;
  const originPath = opt(p.originPath) ?? null;
  const applied = 'EXISTS (SELECT 1 FROM plans WHERE project_id = ? AND plan_key = ? AND event_id = ?)';
  const newer = '(excluded.updated_at > plans.updated_at OR (excluded.updated_at = plans.updated_at AND excluded.event_id < plans.event_id))';
  // The content, title and status the row already holds: nothing moves, and the row keeps its stamp and its administrator.
  const identical = '(excluded.content_hash = plans.content_hash AND excluded.title IS plans.title AND (? = 0 OR excluded.status = plans.status))';
  const moves = `${newer} AND NOT ${identical}`;
  const moving = ['event_id', 'title', 'content', 'blob_key', 'content_hash', 'origin_path', 'token_id', 'received_at', 'updated_at'];
  const set = [
    ...moving.map((column) => `${column} = CASE WHEN ${moves} THEN excluded.${column} ELSE plans.${column} END`),
    // An event that names no status leaves the row's alone: a file written again does not reopen a completed plan.
    `status = CASE WHEN ${newer} AND ? = 1 THEN excluded.status ELSE plans.status END`,
    `prompt_id = CASE WHEN ${newer} THEN COALESCE(excluded.prompt_id, plans.prompt_id) ELSE plans.prompt_id END`,
    `updated_by = CASE WHEN ${moves} THEN NULL ELSE plans.updated_by END`,
    `created_at = MIN(plans.created_at, excluded.created_at)`,
  ];
  const setParams = set.flatMap((clause) => Array.from({ length: (clause.match(/\?/g) ?? []).length }, () => statusGiven));
  return {
    // A plan is a Project-shared editorial row: any member may update one, the
    // credential that did is recorded on it, and the creating session and machine
    // stay. The session the event names is still owned by the writing machine.
    identities: [],
    admission: [],
    priors: [
      db.prepare(`SELECT content_hash, origin_path FROM plans WHERE project_id = ? AND plan_key = ?`).bind(ctx.projectId, planKey),
    ],
    projections: [
      db.prepare(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, title, content, blob_key, content_hash, status, origin_path, prompt_id, updated_by, created_at, updated_at, token_id, received_at)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?
           WHERE ${RAW_ROW_GATE}
          ON CONFLICT (project_id, plan_key) DO UPDATE SET
            ${set.join(',\n            ')}`)
        .bind(ctx.projectId, planKey, e.sessionId, e.eventId, ctx.machineId, opt(p.title), opt(p.content), opt(p.blob), contentHash, opt(p.status) ?? 'active', originPath, opt(p.promptId),
              e.createdAt, e.createdAt, ctx.tokenId, ctx.now, ...rawGateParams(ctx, e), ...setParams),
      db.prepare(`DELETE FROM tags WHERE project_id = ? AND entity_kind = 'plan' AND entity_id = ? AND ${applied} AND ${RAW_ROW_GATE}`)
        .bind(ctx.projectId, planKey, ctx.projectId, planKey, e.eventId, ...rawGateParams(ctx, e)),
      db.prepare(`INSERT OR IGNORE INTO tags (project_id, entity_kind, entity_id, tag)
          SELECT ?, 'plan', ?, value FROM json_each(?) WHERE ${applied} AND ${RAW_ROW_GATE}`)
        .bind(ctx.projectId, planKey, tags, ctx.projectId, planKey, e.eventId, ...rawGateParams(ctx, e)),
    ],
    reads: [],
    refusal: () => NOT_STORED,
    conflict: () => 'plan did not apply',
    // New content arriving from another source than the row's: the signal an operator reads when two channels write one plan.
    landed: (priors) => {
      const prior = priors[0]?.[0] as { content_hash: string; origin_path: string | null } | undefined;
      if (prior === undefined) return;
      if (prior.content_hash !== contentHash && (prior.origin_path ?? null) !== originPath) emit({ kind: 'plan_overwritten', projectId: ctx.projectId, sessionId: e.sessionId, planKey });
    },
  };
};

const attachment = ({ db, ctx, e, p }: Inputs): KindPlan => {
  const blob = p.blob as string;
  return {
    identities: [{ table: 'attachments', keyColumn: 'attachment_id', key: p.attachmentId as string, owner: 'session' }],
    admission: [],
    projections: [
      db.prepare(`INSERT INTO attachments (project_id, attachment_id, session_id, prompt_id, event_id, blob_key, media_type, byte_size, description, origin_path, created_at, token_id, received_at)
          SELECT ?, ?, ?, ?, ?, b.key, b.media_type, b.size, ?, ?, ?, ?, ?
            FROM blobs b WHERE b.project_id = ? AND b.key = ? AND ${RAW_ROW_GATE}
          ON CONFLICT (project_id, attachment_id) DO NOTHING`)
        .bind(ctx.projectId, p.attachmentId, e.sessionId, opt(p.promptId), e.eventId, opt(p.description), opt(p.originPath), e.createdAt, ctx.tokenId, ctx.now,
              ctx.projectId, blob, ...rawGateParams(ctx, e)),
    ],
    reads: [],
    refusal: () => NOT_STORED,
    conflict: () => 'attachment id already stored',
  };
};

const transcriptSegment = ({ db, ctx, e, p }: Inputs): KindPlan => {
  const transcriptId = p.transcriptId as string;
  const baseOffset = p.baseOffset as number;
  const length = p.length as number;
  const blob = p.blob as string;
  const size = baseOffset + length;
  const held = 'COALESCE((SELECT size FROM transcripts WHERE project_id = ? AND transcript_id = ?), 0)';
  const segmentWritten = 'EXISTS (SELECT 1 FROM transcript_segments WHERE project_id = ? AND transcript_id = ? AND base_offset = ? AND event_id = ?)';
  const owned = (rows: ReadRows): { size: number; segment_count: number } | null => {
    const transcript = rows[0]?.[0] as { size: number; segment_count: number; machine_id: string } | undefined;
    return transcript && transcript.machine_id === ctx.machineId ? transcript : null;
  };
  return {
    identities: [{ table: 'transcripts', keyColumn: 'transcript_id', key: transcriptId, owner: 'row' }],
    admission: [
      { sql: `EXISTS (SELECT 1 FROM blobs WHERE project_id = ? AND key = ? AND size = ?)`, params: [ctx.projectId, blob, length] },
      { sql: `${held} = ?`, params: [ctx.projectId, transcriptId, baseOffset] },
    ],
    projections: [
      db.prepare(`INSERT INTO transcript_segments (project_id, transcript_id, base_offset, length, blob_key, event_id, created_at, received_at, token_id)
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${RAW_ROW_GATE}
          ON CONFLICT (project_id, transcript_id, base_offset) DO NOTHING`)
        .bind(ctx.projectId, transcriptId, baseOffset, length, blob, e.eventId, e.createdAt, ctx.now, ctx.tokenId, ...rawGateParams(ctx, e)),
      db.prepare(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, origin_path, size, segment_count, first_received_at, last_received_at, token_id)
          SELECT ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ? WHERE ${RAW_ROW_GATE} AND ${segmentWritten}
          ON CONFLICT (project_id, transcript_id) DO UPDATE SET size = excluded.size, segment_count = transcripts.segment_count + 1, last_received_at = excluded.last_received_at`)
        .bind(ctx.projectId, transcriptId, e.sessionId, ctx.machineId, opt(p.agent), opt(p.originPath), size, ctx.now, ctx.now, ctx.tokenId,
              ...rawGateParams(ctx, e), ctx.projectId, transcriptId, baseOffset, e.eventId),
    ],
    reads: [
      db.prepare(`SELECT size, segment_count, machine_id FROM transcripts WHERE project_id = ? AND transcript_id = ?`).bind(ctx.projectId, transcriptId),
      db.prepare(`SELECT blob_key, length FROM transcript_segments WHERE project_id = ? AND transcript_id = ? AND base_offset = ?`).bind(ctx.projectId, transcriptId, baseOffset),
      db.prepare(`SELECT size FROM blobs WHERE project_id = ? AND key = ?`).bind(ctx.projectId, blob),
    ],
    refusal: (rows) => {
      const transcript = rows[0]?.[0] as { size: number } | undefined;
      const blobRow = rows[2]?.[0] as { size: number } | undefined;
      if (blobRow !== undefined && blobRow.size !== length) return refusal('blob size does not match length', 'blob_length_mismatch');
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

const PLANNERS: Record<KindSpec['projection'], (input: Inputs) => KindPlan> = {
  raw: rawOnly,
  sessions: (input) => (input.e.kind === 'session.start' ? sessionStart(input) : sessionEnd(input)),
  prompt_batches: prompt,
  tool_calls: toolCall,
  responses: response,
  plans: plan,
  attachments: attachment,
  transcript_segments: transcriptSegment,
};

/** The projection plan for one validated event. */
export function planKind(spec: KindSpec, input: Omit<Inputs, 'spec'>): KindPlan {
  return PLANNERS[spec.projection]({ ...input, spec });
}
