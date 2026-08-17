import type { D1Like, Env } from '../env.js';
import type { RouteContext } from '../context.js';
import { sha256Hex } from '../hash.js';
import { classify, emit } from '../telemetry.js';
import { parseEnvelope } from './envelope.js';

export interface IngestResult {
  persisted: boolean;
  duplicate?: boolean;
  reason?: string;
}

export type IngestContext = Omit<RouteContext, 'body' | 'now'>;

/** Stores one event in a single transaction: session upsert, event insert, and a quota charge that applies only when the insert wrote a row. A conflicting event id with a different payload is refused; an identical replay is reported as a duplicate. */
export async function ingestEvent(db: D1Like, ctx: IngestContext, body: unknown, nowMs: number): Promise<IngestResult> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) {
    emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: parsed.reason });
    return { persisted: false, reason: parsed.reason };
  }
  const e = parsed.value;
  const payloadHash = await sha256Hex(e.payloadJson);

  const session = db
    .prepare(`INSERT INTO sessions
        (project_id, session_id, machine_id, created_by_token_id, transport, started_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, session_id) DO UPDATE SET
        updated_at = excluded.updated_at,
        started_at = MIN(started_at, excluded.started_at)`)
    .bind(ctx.projectId, e.sessionId, ctx.machineId, ctx.tokenId, e.transport, e.createdAt, nowMs);

  const event = db
    .prepare(`INSERT INTO events
        (project_id, event_id, session_id, token_id, kind, payload, payload_hash, created_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, event_id) DO NOTHING`)
    .bind(ctx.projectId, e.eventId, e.sessionId, ctx.tokenId, e.kind, e.payloadJson, payloadHash, e.createdAt, nowMs);

  const quota = db
    .prepare(`UPDATE member_tokens SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`)
    .bind(ctx.bodyBytes, ctx.tokenId);

  const results = await db.batch([session, event, quota]);
  if (results.length !== 3) throw new Error(`D1_ERROR: batch returned ${results.length} results`);

  if (results[1].meta.changes === 0) {
    const stored = await db
      .prepare(`SELECT payload_hash FROM events WHERE project_id = ? AND event_id = ?`)
      .bind(ctx.projectId, e.eventId)
      .first<{ payload_hash: string }>();
    if (stored?.payload_hash === payloadHash) {
      emit({ kind: 'ingest_duplicate', projectId: ctx.projectId, tokenId: ctx.tokenId });
      return { persisted: true, duplicate: true };
    }
    emit({ kind: 'ingest_conflict', projectId: ctx.projectId, tokenId: ctx.tokenId });
    return { persisted: false, reason: 'event id conflict' };
  }
  emit({ kind: 'ingest_ok', projectId: ctx.projectId, tokenId: ctx.tokenId });
  return { persisted: true };
}

export async function handleEvents(env: Env, ctx: RouteContext): Promise<Response> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body);
  } catch (err) {
    emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, error_class: classify(err) });
    return Response.json({ persisted: false, reason: 'body must be JSON' });
  }
  return Response.json(await ingestEvent(env.MYCO_DB, ctx, parsed, ctx.now));
}
