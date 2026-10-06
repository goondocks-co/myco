import type { RelationalStore, PreparedStatement, ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { emit, refusal, StorageContractError, TokenRevokedError, type Classifier, type Refusal } from '../telemetry.js';
import { parseEnvelope, type CaptureEnvelope, type Refused } from './envelope.js';
import { kindSpec, parsePayload, type KindSpec, type Payload } from './kinds.js';
import { pendingSearchBlobs } from '../core/search-index.js';
import { TRANSCRIPT_PARSE_ADAPTER } from '../constants.js';
import { planKind, projectLive, sharedChecks, type Fragment, type KindPlan, type ReadRows, type WriteContext } from './projections.js';
import { ALWAYS, credentialLive } from './live-credential.js';
import { endsTurn, endTurnStatement, startTurnFromEventStatement, turnStartFrom } from './turns.js';
import { discardDerivedContent, prepareDerivedContent, type DerivedContentSource } from '../core/registered-content.js';
import { toolInputPreview } from '../core/tool-input.js';

/** The held size and segment count of a transcript, answered on every outcome of a `transcript.segment`. */
export interface TranscriptExtra {
  transcript?: { size: number; segmentCount: number };
}

/** Stored (projected, or a duplicate), stored but not projected (a conflict with its stable `code`), or refused with its stable `code`: a refusal or a conflict without a `code` cannot be built. */
export type IngestResult =
  | ({ persisted: true; duplicate?: boolean; projected?: true } & TranscriptExtra)
  | ({ persisted: true; projected: false; code: Classifier; reason: string } & TranscriptExtra)
  | ({ persisted: false; code: Classifier; reason: string } & TranscriptExtra);

/**
 * Who is writing.
 *
 * `member` is a credentialed caller: the write is admitted only while its
 * credential is live, and its bytes are counted on that credential for
 * reporting. `server` is the Deployment writing from bytes it has already
 * accepted and already counted — a transcript it parsed — so it is counted
 * nothing and its admission does not consult a
 * credential's liveness. A member's credential rotates; the events derived from
 * the bytes that credential shipped must not stop landing when it does.
 */
export type WriteOrigin = 'member' | 'server';

export type IngestContext = Pick<RouteContext, 'projectId' | 'machineId' | 'tokenId' | 'bodyBytes' | 'now' | 'turnEnd'> & { writeOrigin?: WriteOrigin; /** The member acting through a server-origin write, where a projection records who acted; absent for a member's own capture and for derived events. */ actor?: string };

/** A terminal refusal of the caller's own request: 200 `{persisted:false, code, reason}` plus one `ingest_refused` event carrying the refusal's classifier only. */
export function refused(ctx: Pick<IngestContext, 'projectId' | 'tokenId'>, { reason, classifier }: Refusal): IngestResult {
  emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  return { persisted: false, code: classifier, reason };
}

/** Digest of the whole envelope: session, kind, caller time, channel, producer, and the serialized payload. */
export async function envelopeHash(e: CaptureEnvelope): Promise<string> {
  const header = utf8(`${JSON.stringify([e.sessionId, e.kind, e.createdAt, e.channel, e.producer.adapter, e.producer.version])}\n`);
  const bytes = new Uint8Array(header.byteLength + e.payloadBytes.byteLength);
  bytes.set(header, 0);
  bytes.set(e.payloadBytes, header.byteLength);
  return sha256HexOf(bytes);
}

/** The content hash a text-bearing kind records: sha256 of the inline text, or the blob key when spilled. */
async function contentHashOf(spec: KindSpec, p: Payload): Promise<string | null> {
  const inline = spec.exactlyOne?.[0];
  if (inline === undefined) return null;
  if (typeof p[inline] === 'string') return sha256Hex(p[inline] as string);
  return typeof p.blob === 'string' ? (p.blob as string) : null;
}

/** The blob key holding a kind's spilled text field, when the text travelled as a blob. */
function spilledKey(spec: KindSpec, p: Payload): string | null {
  const pair = spec.exactlyOne ?? spec.atMostOne;
  return pair && pair[1] === 'blob' && typeof p.blob === 'string' ? (p.blob as string) : null;
}

/** Stores one event in a single transaction. The raw insert carries every admission precondition — the credential still live (`credentialLive`; never a volume: capture is not refused for the bytes a credential has stored), the shared checks derived from the catalogue and the kind's declared identities (session identity, the continued rows the kind names, referenced blobs present, referenced prompts owned by this machine — in that order) and the kind's own — so a refused event leaves no row and no count; the byte count, the session receipt, and the kind's projections apply only to the raw row this request wrote, named by a per-request nonce; same-batch reads decide the response. A stored event is read through its session's machine, so a duplicate or a conflict is answered only to the machine that wrote it and another machine's event id is refused like any other unstored one. */
export async function ingestEvent(db: RelationalStore, ctx: IngestContext, body: unknown, env?: Pick<ServerEnv, 'db' | 'blobs'>): Promise<IngestResult> {
  const planned = await planEventWrite(db, ctx, body, env);
  if (!planned.ok) return refused(ctx, planned);
  let result: IngestResult;
  try {
    const results = await db.batch(planned.write.statements);
    result = planned.write.interpret(results);
  } catch (error) {
    await planned.write.releaseUnlinked?.();
    throw error;
  }
  await planned.write.releaseUnlinked?.();
  return result;
}

/** The statements one event needs and how to read their answers, without executing them. Callers with one event run their own batch; a caller with many concatenates the statements of each into ONE batch and interprets each write's own slice — the difference between one database call per event and one per pass. */
export interface EventWrite {
  statements: PreparedStatement[];
  interpret(results: BatchResult[]): IngestResult;
  releaseUnlinked?(): Promise<number>;
  preparationCalls?: number;
}

export type PlannedWrite = { ok: true; write: EventWrite } | Refused;

/** What `db.batch` answers per statement; the shape the interpreter reads. */
type BatchResult = { results: unknown[]; meta: { changes: number } };

export async function planEventWrite(db: RelationalStore, ctx: IngestContext, body: unknown, env?: Pick<ServerEnv, 'db' | 'blobs'>): Promise<PlannedWrite> {
  const parsed = parseEnvelope(body, ctx.now);
  if (!parsed.ok) return parsed;
  const e = parsed.value;
  // The transcript parser adapter is reserved for server-origin writes.
  if (e.producer.adapter === TRANSCRIPT_PARSE_ADAPTER && (ctx.writeOrigin ?? 'member') === 'member') {
    return { ok: false, ...refusal(`producer.adapter ${TRANSCRIPT_PARSE_ADAPTER} is reserved for the Deployment's transcript parser`, 'invalid_field') };
  }
  const spec = kindSpec(e.kind);
  if (!spec) return { ok: false, ...refusal(`unknown kind ${e.kind}`, 'unknown_kind') };
  const payload = parsePayload(spec, e.payload, ctx.now);
  if (!payload.ok) return payload;
  const p = payload.value;

  const write: WriteContext = { projectId: ctx.projectId, tokenId: ctx.tokenId, machineId: ctx.machineId, now: ctx.now, nonce: crypto.randomUUID(), actor: ctx.actor ?? null, processing: ctx.writeOrigin === 'server' && e.producer.adapter === TRANSCRIPT_PARSE_ADAPTER };
  const digest = await envelopeHash(e);
  const contentHash = await contentHashOf(spec, p);
  const fullInput = spec.projection === 'tool_calls' && p.input !== undefined ? JSON.stringify(p.input) : null;
  const inputDisplay = fullInput === null ? null : toolInputPreview(fullInput);
  if (inputDisplay?.truncated && env === undefined) throw new Error('Oversized tool input requires server blob storage');
  const inputSource: DerivedContentSource | undefined = inputDisplay?.truncated
    ? {
        projectId: ctx.projectId, sessionId: e.sessionId, eventId: e.eventId, tokenId: ctx.tokenId,
        envelopeHash: digest, sourceKind: 'tool-input', resourceId: p.toolCallId as string,
        memberTokenId: (ctx.writeOrigin ?? 'member') === 'member' ? ctx.tokenId : undefined,
      }
    : undefined;
  const preparedToolInput = inputSource && env
    ? await prepareDerivedContent(env, inputSource, fullInput!, ctx.now)
    : undefined;
  const plan: KindPlan = planKind(spec, { db, ctx: write, e, p, contentHash, preparedToolInput });
  // A server-origin write is counted nothing and consults no credential's
  // liveness: the bytes it derives from were accepted and counted when the
  // member shipped them, and that member's credential rotates on its own
  // schedule. `ALWAYS` keeps the admission's shape so the raw insert and the
  // same-batch read stay one expression.
  const charged = (ctx.writeOrigin ?? 'member') === 'member';
  const liveAdmission = charged ? credentialLive(ctx.tokenId) : ALWAYS;
  const checks = [projectLive(write), ...sharedChecks(spec, write, e, p, plan.identities)];
  const admission: Fragment[] = [liveAdmission, ...checks.map((c) => c.admission), ...plan.admission];

  const raw = db
    .prepare(`INSERT INTO events
        (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, producer_adapter, producer_version, blob_key, payload_bytes, ingest_nonce)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${admission.map((a) => a.sql).join(' AND ')}
      ON CONFLICT (project_id, event_id) DO NOTHING`)
    .bind(ctx.projectId, e.eventId, e.sessionId, ctx.tokenId, e.kind, e.channel, e.payloadJson, digest, e.createdAt, ctx.now,
          e.producer.adapter, e.producer.version, spilledKey(spec, p), e.payloadBytes.byteLength, write.nonce,
          ...admission.flatMap((a) => a.params));

  const counted = charged
    ? db.prepare(`UPDATE member_credentials SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`).bind(ctx.bodyBytes, ctx.tokenId)
    : db.prepare(`SELECT 1 AS uncharged`);

  // A receipt records when a MEMBER last made contact. The Deployment reading
  // its own stored bytes is not contact: a parse advancing the stamp would date
  // a month-old backfilled session to now, and would hold the Deployment awake
  // on its own housekeeping. A server write still opens a session row that is
  // absent, so a derived event is never refused for want of one.
  const receipt = charged
    ? db
      .prepare(`INSERT INTO sessions
          (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)
        ON CONFLICT (project_id, session_id) DO UPDATE SET last_received_at = excluded.last_received_at`)
      .bind(ctx.projectId, e.sessionId, ctx.machineId, ctx.tokenId, ctx.now, ctx.now, ctx.projectId, e.eventId, write.nonce)
    : db
      .prepare(`INSERT INTO sessions
          (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
        SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)
        ON CONFLICT (project_id, session_id) DO NOTHING`)
      .bind(ctx.projectId, e.sessionId, ctx.machineId, ctx.tokenId, e.createdAt, e.createdAt, ctx.projectId, e.eventId, write.nonce);

  // The nonce, not a change count, decides whether THIS write stored the row.
  // A batch carrying several events reports its counts per driver rather than
  // per statement, and the nonce is written by the insert itself: reading it
  // back asks the store what happened instead of asking the driver.
  const stored = db
    .prepare(`SELECT ev.envelope_hash, ev.ingest_nonce FROM events ev
        JOIN sessions s ON s.project_id = ev.project_id AND s.session_id = ev.session_id
       WHERE ev.project_id = ? AND ev.event_id = ? AND s.machine_id IS ?`)
    .bind(ctx.projectId, e.eventId, ctx.machineId);

  const admitted = db.prepare(`SELECT ${liveAdmission.sql} AS live`).bind(...liveAdmission.params);
  const shared = checks.map((c) => db.prepare(c.read.sql).bind(...c.read.params));
  const priors = plan.priors ?? [];
  // Beside the projections in the batch, outside the evidence a conflict is read from.
  // A turn's end moves the session's last turn end and closes its open turn, unless the turn started after it.
  const turnEnd = endsTurn(e, ctx.turnEnd === true, p)
    ? [endTurnStatement(db, { projectId: ctx.projectId, sessionId: e.sessionId, eventId: e.eventId, endedAt: e.createdAt, nonce: write.nonce })]
    : [];
  // A turn start opens the session's turn at its own instant, after the receipt has opened the session row it names.
  const startedAt = turnStartFrom(e, p, ctx.now);
  const turnStart = startedAt === null
    ? []
    : [startTurnFromEventStatement(db, { projectId: ctx.projectId, sessionId: e.sessionId, machineId: ctx.machineId, at: startedAt, eventId: e.eventId, nonce: write.nonce })];
  const liveCapture = e.channel === 'import' ? [] : [db.prepare(`UPDATE sessions
      SET last_live_received_at = MAX(COALESCE(last_live_received_at, 0), ?)
      WHERE project_id = ? AND session_id = ?
        AND EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)`)
    .bind(ctx.now, ctx.projectId, e.sessionId, ctx.projectId, e.eventId, write.nonce)];
  const incidental = [...(plan.incidental ?? []), ...turnEnd, ...turnStart, ...liveCapture];
  const statements: PreparedStatement[] = [raw, counted, receipt, ...priors, ...plan.projections, ...incidental, stored, admitted, ...shared, ...plan.reads];

  const interpret = (results: BatchResult[]): IngestResult => {
  if (results.length !== statements.length) throw new StorageContractError(`batch answered ${results.length} results for ${statements.length} statements`);

  const base = 3 + priors.length;
  const priorRows: ReadRows = results.slice(3, base).map((r) => r.results as Record<string, unknown>[]);
  const projectionResults = results.slice(base, base + plan.projections.length);
  const afterWrites = base + plan.projections.length + incidental.length;
  const storedRow = results[afterWrites].results[0] as { envelope_hash?: string; ingest_nonce?: string } | undefined;
  const liveRow = results[afterWrites + 1].results[0] as { live: number } | undefined;
  const allReads: ReadRows = results.slice(afterWrites + 2).map((r) => r.results as Record<string, unknown>[]);
  const sharedRows = allReads.slice(0, checks.length);
  const reads = allReads.slice(checks.length);
  const extra = plan.extra ? plan.extra(reads) : {};

  if (storedRow?.ingest_nonce === write.nonce) {
    if (plan.projections.length > 0 && projectionResults.every((r) => r.meta.changes === 0)) {
      const reason = plan.conflict ? plan.conflict(reads) : 'projection did not apply';
      emit({ kind: 'projection_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId, eventKind: e.kind });
      return { persisted: true, projected: false, code: 'projection_conflict', reason, ...extra };
    }
    plan.landed?.(priorRows);
    emit({ kind: 'ingest_ok', projectId: ctx.projectId, tokenId: ctx.tokenId, eventKind: e.kind });
    return plan.projections.length > 0 ? { persisted: true, projected: true, ...extra } : { persisted: true, ...extra };
  }
  if (storedRow) {
    if (storedRow.envelope_hash === digest) {
      emit({ kind: 'ingest_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return { persisted: true, duplicate: true, ...extra };
    }
    emit({ kind: 'ingest_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId });
    return { persisted: false, code: 'event_id_conflict', reason: 'event id conflict', ...extra };
  }
  if (plan.heldDuplicate && plan.heldDuplicate(reads)) {
    emit({ kind: 'ingest_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId });
    return { persisted: true, duplicate: true, ...extra };
  }
  // A credential revoked after this request authenticated: not the caller's
  // request at fault, so no terminal refusal. The pipeline answers 503 and the
  // retry meets the revocation at authentication.
  if (liveRow?.live !== 1) throw new TokenRevokedError(ctx.tokenId);
  const sharedRefusal = checks.map((c, i) => c.refusal(sharedRows[i]?.[0])).find((r) => r !== null) ?? null;
  return { ...refused(ctx, sharedRefusal ?? plan.refusal(reads)), ...extra };
  };

  const releaseUnlinked = inputSource && preparedToolInput && env
    ? () => discardDerivedContent(env, inputSource, preparedToolInput.key, ctx.now)
    : undefined;
  return { ok: true, write: { statements, interpret, releaseUnlinked, preparationCalls: preparedToolInput?.preparationCalls } };
}

/** The kind whose projected arrival, on any channel but import, asks for its session's title. */
const SESSION_END_KIND = 'session.end';
/** The channel a member ships pre-existing bytes on; an end arriving over it asks for no title. */
const IMPORT_CHANNEL = 'import';
/** The kind whose projected arrival leaves the Deployment bytes to read. */
const TRANSCRIPT_SEGMENT_KIND = 'transcript.segment';

export async function handleEvents(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return Response.json(refused(ctx, refusal('body must be JSON', 'parse')));
  }
  const result = await ingestEvent(env.db, ctx, parsed, env);
  const envelope = parsed as { kind?: unknown; sessionId?: unknown; channel?: unknown; payload?: { blob?: unknown } } | null;
  if (result.persisted && result.projected === true && typeof envelope?.payload?.blob === 'string') {
    env.afterResponse(async () => {
      try {
        if (await pendingSearchBlobs(env.db, ctx.projectId) > 0) await env.wake?.();
      } catch {
        emit({ kind: 'search_wake_failed', projectId: ctx.projectId });
      }
    });
  }
  // Segment bytes are unread until a pass reads them; the clock is nudged so
  // the rows appear on the next wake rather than at the next idle cadence.
  if (result.persisted && result.projected === true && envelope?.kind === TRANSCRIPT_SEGMENT_KIND) {
    env.afterResponse(async () => {
      try { await env.wake?.(); } catch { emit({ kind: 'transcript_wake_failed', projectId: ctx.projectId }); }
    });
  }
  // A live end asks for a title, which a wake takes once the session has
  // settled; the clock is nudged so a Deployment asleep wakes into the active
  // cadence and takes it then, rather than at its floor.
  if (result.persisted && result.projected === true && envelope?.kind === SESSION_END_KIND && envelope.channel !== IMPORT_CHANNEL) {
    env.afterResponse(async () => {
      try { await env.wake?.(); } catch { emit({ kind: 'title_wake_failed', projectId: ctx.projectId }); }
    });
  }
  return Response.json(result);
}
