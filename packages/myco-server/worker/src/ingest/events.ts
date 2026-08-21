import type { D1Like, D1StatementLike, Env } from '../env.js';
import type { RouteContext } from '../context.js';
import { sha256Hex, sha256HexOf, utf8 } from '../hash.js';
import { emit, refusal, type Classifier, type Refusal } from '../telemetry.js';
import { parseEnvelope, type CaptureEnvelope } from './envelope.js';
import { kindSpec, parsePayload, type KindSpec, type Payload } from './kinds.js';
import { planKind, sharedChecks, type Fragment, type KindPlan, type ReadRows, type WriteContext } from './projections.js';
import { withinQuota } from './quota.js';

export interface IngestResult {
  persisted: boolean;
  duplicate?: boolean;
  projected?: boolean;
  /** The stable class of a refusal or a conflict; present whenever `reason` is. */
  code?: Classifier;
  reason?: string;
  transcript?: { size: number; segmentCount: number };
}

export type IngestContext = Pick<RouteContext, 'projectId' | 'machineId' | 'tokenId' | 'bodyBytes' | 'now'>;

/** A terminal refusal of the caller's own request: 200 `{persisted:false, code, reason}` plus one `ingest_refused` event carrying the refusal's classifier only. */
export function refused(ctx: Pick<IngestContext, 'projectId' | 'tokenId'>, { reason, classifier }: Refusal): IngestResult {
  emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  return { persisted: false, code: classifier, reason };
}

/** Digest of the whole envelope: session, kind, caller time, channel, producer, and the serialized payload. */
async function envelopeHash(e: CaptureEnvelope): Promise<string> {
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

export const QUOTA_REASON = 'token write quota exceeded';
const OVER_QUOTA: Refusal = refusal(QUOTA_REASON, 'quota');

/** Stores one event in a single transaction. The raw insert carries every admission precondition — the quota (`withinQuota`: the one counter plus the token's live blob reservations, so event traffic never takes the room an upload in flight holds), the shared checks derived from the catalogue and the kind's declared identities (session identity, the continued rows the kind names, referenced blobs present, referenced prompts owned by this machine — in that order) and the kind's own — so a refused event leaves no row and no charge; the quota charge, the session receipt, and the kind's projections apply only to the raw row this request wrote, named by a per-request nonce; same-batch reads decide the response. A stored event is read through its session's machine, so a duplicate or a conflict is answered only to the machine that wrote it and another machine's event id is refused like any other unstored one. */
export async function ingestEvent(db: D1Like, ctx: IngestContext, body: unknown): Promise<IngestResult> {
  const parsed = parseEnvelope(body, ctx.now);
  if (!parsed.ok) return refused(ctx, parsed);
  const e = parsed.value;
  const spec = kindSpec(e.kind);
  if (!spec) return refused(ctx, refusal(`unknown kind ${e.kind}`, 'unknown_kind'));
  const payload = parsePayload(spec, e.payload, ctx.now);
  if (!payload.ok) return refused(ctx, payload);
  const p = payload.value;

  const write: WriteContext = { projectId: ctx.projectId, tokenId: ctx.tokenId, machineId: ctx.machineId, now: ctx.now, nonce: crypto.randomUUID() };
  const digest = await envelopeHash(e);
  const contentHash = await contentHashOf(spec, p);
  const plan: KindPlan = planKind(spec, { db, ctx: write, e, p, contentHash });
  const quotaAdmission = withinQuota(write, ctx.bodyBytes);
  const checks = sharedChecks(spec, write, e, p, plan.identities);
  const admission: Fragment[] = [quotaAdmission, ...checks.map((c) => c.admission), ...plan.admission];

  const raw = db
    .prepare(`INSERT INTO events
        (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at, producer_adapter, producer_version, blob_key, payload_bytes, ingest_nonce)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
       WHERE ${admission.map((a) => a.sql).join(' AND ')}
      ON CONFLICT (project_id, event_id) DO NOTHING`)
    .bind(ctx.projectId, e.eventId, e.sessionId, ctx.tokenId, e.kind, e.channel, e.payloadJson, digest, e.createdAt, ctx.now,
          e.producer.adapter, e.producer.version, spilledKey(spec, p), e.payloadBytes.byteLength, write.nonce,
          ...admission.flatMap((a) => a.params));

  const quota = db
    .prepare(`UPDATE member_tokens SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`)
    .bind(ctx.bodyBytes, ctx.tokenId);

  const receipt = db
    .prepare(`INSERT INTO sessions
        (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND ingest_nonce = ?)
      ON CONFLICT (project_id, session_id) DO UPDATE SET last_received_at = excluded.last_received_at`)
    .bind(ctx.projectId, e.sessionId, ctx.machineId, ctx.tokenId, ctx.now, ctx.now, ctx.projectId, e.eventId, write.nonce);

  const stored = db
    .prepare(`SELECT ev.envelope_hash FROM events ev
        JOIN sessions s ON s.project_id = ev.project_id AND s.session_id = ev.session_id
       WHERE ev.project_id = ? AND ev.event_id = ? AND s.machine_id IS ?`)
    .bind(ctx.projectId, e.eventId, ctx.machineId);

  const admitted = db.prepare(`SELECT ${quotaAdmission.sql} AS within_quota`).bind(...quotaAdmission.params);
  const shared = checks.map((c) => db.prepare(c.read.sql).bind(...c.read.params));
  const statements: D1StatementLike[] = [raw, quota, receipt, ...plan.projections, stored, admitted, ...shared, ...plan.reads];
  const results = await db.batch(statements);
  if (results.length !== statements.length) throw new Error(`D1_ERROR: batch returned ${results.length} results`);

  const projectionResults = results.slice(3, 3 + plan.projections.length);
  const storedRow = results[3 + plan.projections.length].results[0] as { envelope_hash?: string } | undefined;
  const withinQuotaRow = results[4 + plan.projections.length].results[0] as { within_quota: number } | undefined;
  const allReads: ReadRows = results.slice(5 + plan.projections.length).map((r) => r.results as Record<string, unknown>[]);
  const sharedRows = allReads.slice(0, checks.length);
  const reads = allReads.slice(checks.length);
  const extra = plan.extra ? plan.extra(reads) : {};

  if (results[0].meta.changes === 1) {
    if (plan.projections.length > 0 && projectionResults.every((r) => r.meta.changes === 0)) {
      const reason = plan.conflict ? plan.conflict(reads) : 'projection did not apply';
      emit({ kind: 'projection_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId, eventKind: e.kind });
      return { persisted: true, projected: false, code: 'projection_conflict', reason, ...extra };
    }
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
  if (withinQuotaRow?.within_quota !== 1) return { ...refused(ctx, OVER_QUOTA), ...extra };
  const sharedRefusal = checks.map((c, i) => c.refusal(sharedRows[i]?.[0])).find((r) => r !== null) ?? null;
  return { ...refused(ctx, sharedRefusal ?? plan.refusal(reads)), ...extra };
}

export async function handleEvents(env: Env, ctx: RouteContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch {
    return Response.json(refused(ctx, refusal('body must be JSON', 'parse')));
  }
  return Response.json(await ingestEvent(env.MYCO_DB, ctx, parsed));
}
