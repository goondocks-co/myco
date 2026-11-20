import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { toBase64Url } from '../base64.js';
import { sha256Hex } from '../hash.js';
import { badRequest, readJsonObject } from './scope.js';
import { forgetTelemetryKey, insertTelemetryKey, revokeTelemetryKey, telemetryKeys } from '../db/telemetry/keys.js';
import { telemetryCounts } from '../db/telemetry/ingest.js';
import { TELEMETRY_DAY_MS, TELEMETRY_KEY_LIMIT, TELEMETRY_KEY_PREFIX, TELEMETRY_KEY_BYTES, TELEMETRY_KEY_ID_BYTES } from '../core/telemetry-policy.js';

export async function handleTelemetryKeys(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const counts = new Map((await telemetryCounts(env.db, ctx.now - TELEMETRY_DAY_MS)).map(row => [row.key_id, row]));
  return Response.json({ endpoint: ctx.url.origin, keys: (await telemetryKeys(env.db)).map(row => ({
    id: row.id, label: row.label, createdBy: row.created_by, createdAt: row.created_at, lastUsedAt: row.last_used_at, revokedAt: row.revoked_at,
    accepted: counts.get(row.id)?.accepted ?? 0, rejected: counts.get(row.id)?.rejected ?? 0,
    logs: counts.get(row.id)?.logs ?? 0, metrics: counts.get(row.id)?.metrics ?? 0,
  })) });
}
export async function handleIssueTelemetryKey(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.label !== 'string' || !/^[\x20-\x7e]{1,80}$/.test(body.label) || body.label.trim() === '') return badRequest('label must be 1 to 80 printable characters');
  const key = `${TELEMETRY_KEY_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(TELEMETRY_KEY_BYTES)))}`;
  const id = `tk_${toBase64Url(crypto.getRandomValues(new Uint8Array(TELEMETRY_KEY_ID_BYTES)))}`;
  if (!await insertTelemetryKey(env.db, { id, hash: await sha256Hex(key), label: body.label.trim(), actor: ctx.member.id, now: ctx.now })) {
    return Response.json({ error: 'telemetry_key_limit', reason: `No key was saved: Myco holds ${TELEMETRY_KEY_LIMIT} keys. Revoke an unused key and remove its record before creating another.` }, { status: 409 });
  }
  return Response.json({ id, key, endpoint: ctx.url.origin, headers: `Authorization=Bearer%20${key}` }, { status: 201 });
}
export async function handleRevokeTelemetryKey(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return Response.json({ revoked: await revokeTelemetryKey(env.db, { id: ctx.params.keyId, actor: ctx.member.id, now: ctx.now }) });
}
export async function handleForgetTelemetryKey(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return Response.json({ removed: await forgetTelemetryKey(env.db, ctx.params.keyId) });
}
