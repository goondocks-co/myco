import type { D1Like, Env } from '../env.js';
import type { RouteContext } from '../context.js';
import { sha256HexOf, utf8 } from '../hash.js';
import { emit } from '../telemetry.js';
import { parseEnvelope, type CaptureEnvelope } from './envelope.js';

export interface IngestResult {
  persisted: boolean;
  duplicate?: boolean;
  reason?: string;
}

export type IngestContext = Omit<RouteContext, 'body'>;

/** A terminal refusal of the caller's own request: 200 `{persisted:false, reason}` plus one `ingest_refused` event. */
export function refused(ctx: Pick<IngestContext, 'projectId' | 'tokenId'>, reason: string): IngestResult {
  emit({ kind: 'ingest_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason });
  return { persisted: false, reason };
}

/** Digest of the whole envelope: session, kind, caller time, channel, and the serialized payload. */
async function envelopeHash(e: CaptureEnvelope): Promise<string> {
  const header = utf8(`${JSON.stringify([e.sessionId, e.kind, e.createdAt, e.channel])}\n`);
  const bytes = new Uint8Array(header.byteLength + e.payloadBytes.byteLength);
  bytes.set(header, 0);
  bytes.set(e.payloadBytes, header.byteLength);
  return sha256HexOf(bytes);
}

/** Stores one event in a single transaction: the event insert, a quota charge and a session projection that both apply only when the insert wrote a row, and the stored envelope digest for the duplicate decision. A reused event id with an identical envelope is a duplicate; with a different envelope it is a conflict. */
export async function ingestEvent(db: D1Like, ctx: IngestContext, body: unknown): Promise<IngestResult> {
  const parsed = parseEnvelope(body);
  if (!parsed.ok) return refused(ctx, parsed.reason);
  const e = parsed.value;
  const digest = await envelopeHash(e);

  const event = db
    .prepare(`INSERT INTO events
        (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (project_id, event_id) DO NOTHING`)
    .bind(ctx.projectId, e.eventId, e.sessionId, ctx.tokenId, e.kind, e.channel, e.payloadJson, digest, e.createdAt, ctx.now);

  const quota = db
    .prepare(`UPDATE member_tokens SET bytes_written = bytes_written + (? * changes()) WHERE id = ?`)
    .bind(ctx.bodyBytes, ctx.tokenId);

  const session = db
    .prepare(`INSERT INTO sessions
        (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      SELECT ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM events WHERE project_id = ? AND event_id = ? AND token_id = ? AND received_at = ?)
      ON CONFLICT (project_id, session_id) DO UPDATE SET last_received_at = excluded.last_received_at`)
    .bind(ctx.projectId, e.sessionId, ctx.machineId, ctx.tokenId, ctx.now, ctx.now,
          ctx.projectId, e.eventId, ctx.tokenId, ctx.now);

  const stored = db
    .prepare(`SELECT envelope_hash FROM events WHERE project_id = ? AND event_id = ?`)
    .bind(ctx.projectId, e.eventId);

  const results = await db.batch([event, quota, session, stored]);
  if (results.length !== 4) throw new Error(`D1_ERROR: batch returned ${results.length} results`);

  if (results[0].meta.changes === 0) {
    const row = results[3].results[0] as { envelope_hash?: string } | undefined;
    if (row?.envelope_hash === digest) {
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
  } catch {
    return Response.json(refused(ctx, 'body must be JSON'));
  }
  return Response.json(await ingestEvent(env.MYCO_DB, ctx, parsed));
}
