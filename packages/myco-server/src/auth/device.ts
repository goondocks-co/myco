import type { PreparedStatement, ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { toBase64Url } from '../base64.js';
import { sha256Hex } from '../hash.js';
import { badRequest, readJsonObject } from '../api/scope.js';
import { enrollmentInsert, ENROLLMENT_KEY_BYTES, ENROLLMENT_KEY_PATTERN, ENROLLMENT_IDENTITY_PATTERN, type Fragment } from './enrollment.js';
import { joinMember } from './join.js';
import { asMemberRole } from './roles.js';

export const DEVICE_TTL_MS = 10 * 60 * 1000;
export const DEVICE_POLL_SECONDS = 5;
export const DEVICE_SLOW_DOWN_SECONDS = 5;
export const DEVICE_PENDING_PER_SOURCE = 5;
export const DEVICE_STARTS_PER_MINUTE = 10;
const DEVICE_START_WINDOW_MS = 60_000;
const USER_ALPHABET = 'BCDFGHJKLMNPQRSTVWXYZ23456789';
const USER_CODE_LENGTH = 8;
const MAX_METADATA_LENGTH = 128;

interface DeviceRow {
  id: string;
  device_hash: string;
  machine_id: string;
  machine_name: string;
  os: string;
  source_ip: string;
  created_at: number;
  expires_at: number;
  decision: 'approved' | 'denied' | null;
  decided_by: string | null;
}

const deviceError = (error: string, status = 400, interval?: number): Response =>
  Response.json({ error, ...(interval === undefined ? {} : { interval }) }, { status });

function newUserCode(): string {
  let code = '';
  const ceiling = Math.floor(256 / USER_ALPHABET.length) * USER_ALPHABET.length;
  while (code.length < USER_CODE_LENGTH) {
    const byte = crypto.getRandomValues(new Uint8Array(1))[0]!;
    if (byte < ceiling) code += USER_ALPHABET[byte % USER_ALPHABET.length];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function metadata(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= MAX_METADATA_LENGTH && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
}

/** Starts a request with digest-only codes; the source is resolved by the serving entry, never by the request body. */
export async function handleDeviceStart(env: ServerEnv, request: Request, now: number, source: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => !['machineId', 'machineName', 'os'].includes(k))
    || typeof body.machineId !== 'string' || !ENROLLMENT_IDENTITY_PATTERN.test(body.machineId) || !metadata(body.machineName) || !metadata(body.os)) {
    return badRequest('machineId, machineName and os are required');
  }
  const deviceCode = toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_BYTES)));
  const userCode = newUserCode();
  const id = `en_device_${crypto.randomUUID()}`;
  const inserted = await env.db.prepare(`INSERT INTO device_requests
    (id,device_hash,user_hash,machine_id,machine_name,os,source_ip,created_at,expires_at,interval_seconds,next_poll_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE
      NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ? AND decision IS NULL AND expires_at > ? LIMIT 1 OFFSET ?)
      AND NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ? AND created_at > ? LIMIT 1 OFFSET ?)`)
    .bind(id, await sha256Hex(deviceCode), await sha256Hex(userCode.replace('-', '')),
      body.machineId, body.machineName, body.os, source, now, now + DEVICE_TTL_MS, DEVICE_POLL_SECONDS, now,
      source, now, DEVICE_PENDING_PER_SOURCE - 1, source, now - DEVICE_START_WINDOW_MS, DEVICE_STARTS_PER_MINUTE - 1).run();
  if (inserted.meta.changes !== 1) return deviceError('slow_down', 429, DEVICE_START_WINDOW_MS / 1000);
  const verificationUri = `${new URL(request.url).origin}/device`;
  return Response.json({ device_code: deviceCode, user_code: userCode, verification_uri: verificationUri,
    expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_POLL_SECONDS });
}

/** Polling cadence is advanced atomically, including each persistent RFC 8628 five-second slowdown. */
export async function handleDevicePoll(env: ServerEnv, request: Request, now: number): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => k !== 'device_code') || typeof body.device_code !== 'string' || !ENROLLMENT_KEY_PATTERN.test(body.device_code)) return deviceError('invalid_request');
  const hash = await sha256Hex(body.device_code);
  const row = await env.db.prepare(`SELECT d.*, a.used_at FROM device_requests d
    LEFT JOIN enrollment_authorities a ON a.id = d.id WHERE d.device_hash = ?`).bind(hash).first<DeviceRow & { used_at: number | null }>();
  if (row === null || row.used_at !== null) return deviceError('invalid_grant');
  if (row.expires_at <= now) return deviceError('expired_token');
  if (row.decision === 'denied') return deviceError('access_denied');
  const pacing = await env.db.prepare(`UPDATE device_requests SET
    slowed = CASE WHEN next_poll_at > ? THEN 1 ELSE 0 END,
    interval_seconds = interval_seconds + CASE WHEN next_poll_at > ? THEN ? ELSE 0 END,
    next_poll_at = ? + (interval_seconds + CASE WHEN next_poll_at > ? THEN ? ELSE 0 END) * 1000
    WHERE device_hash = ? AND expires_at > ?
    RETURNING slowed, interval_seconds`).bind(now, now, DEVICE_SLOW_DOWN_SECONDS, now, now, DEVICE_SLOW_DOWN_SECONDS, hash, now)
    .first<{ slowed: number; interval_seconds: number }>();
  if (pacing === null) return deviceError('expired_token');
  if (pacing.slowed === 1) return deviceError('slow_down', 400, pacing.interval_seconds);
  if (row.decision !== 'approved') return deviceError('authorization_pending');
  const joined = await joinMember(env, {
    key: body.device_code, machineId: row.machine_id, runtimeLabel: row.machine_name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64), runtimeKind: 'persistent',
  }, now);
  const answer = await joined.json() as Record<string, unknown>;
  if (answer.joined !== true) return deviceError(answer.code === 'identity_claimed' ? 'identity_claimed' : 'invalid_grant');
  return Response.json(answer);
}

async function requestByUserCode(env: ServerEnv, request: Request): Promise<DeviceRow | Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => k !== 'user_code') || typeof body.user_code !== 'string') return badRequest('user_code required');
  const code = body.user_code.trim().toUpperCase().replace('-', '');
  if (code.length !== USER_CODE_LENGTH || [...code].some(c => !USER_ALPHABET.includes(c))) return deviceError('invalid_user_code', 404);
  const row = await env.db.prepare('SELECT * FROM device_requests WHERE user_hash = ?').bind(await sha256Hex(code)).first<DeviceRow>();
  return row ?? deviceError('invalid_user_code', 404);
}

/** The dashboard sees requesting metadata and a fixed membership scope, never the device secret or its digest. */
export async function handleDevicePreview(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  if (row.expires_at <= ctx.now) return deviceError('expired_token');
  if (row.decision !== null) return deviceError('request_finished', 409);
  const claim = await env.db.prepare('SELECT member_id FROM machine_claims WHERE machine_id = ?').bind(row.machine_id).first<{ member_id: string }>();
  return Response.json({ machineName: row.machine_name, os: row.os, ip: row.source_ip, approverIp: ctx.source,
    ageSeconds: Math.max(0, Math.floor((ctx.now - row.created_at) / 1000)), alreadyYours: claim?.member_id === ctx.member.id,
    scope: 'membership', expiresAt: row.expires_at });
}

function pendingDevice(id: string, now: number): Fragment {
  return { sql: `EXISTS (SELECT 1 FROM device_requests d WHERE d.id = ? AND d.decision IS NULL AND d.expires_at > ?
    AND NOT EXISTS (SELECT 1 FROM device_decision_audit a WHERE a.request_id = d.id))`, params: [id, now] };
}

/** A decision and its immutable audit receipt commit together; a pending request admits exactly one decision. */
async function decideDevice(env: ServerEnv, ctx: OwnerContext, row: DeviceRow, decision: 'approved' | 'denied', enrollment?: PreparedStatement): Promise<boolean> {
  const pending = pendingDevice(row.id, ctx.now);
  const update = env.db.prepare(`UPDATE device_requests SET decision = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND ${pending.sql}
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at IS NULL AND role IN ('admin','member'))
      ${decision === 'approved' ? 'AND EXISTS (SELECT 1 FROM enrollment_authorities WHERE id = ? AND created_by_member = ?)' : ''}`)
    .bind(decision, ctx.member.id, ctx.now, row.id, ...pending.params, ctx.member.id,
      ...(decision === 'approved' ? [row.id, ctx.member.id] : []));
  const audit = env.db.prepare(`INSERT INTO device_decision_audit (request_id,member_id,machine_id,machine_name,os,source_hash,decision,decided_at)
    SELECT id,decided_by,machine_id,machine_name,os,?,decision,decided_at FROM device_requests
    WHERE id = ? AND decision = ? AND decided_by = ? AND decided_at = ?
      AND NOT EXISTS (SELECT 1 FROM device_decision_audit WHERE request_id = ?)`)
    .bind(await sha256Hex(row.source_ip), row.id, decision, ctx.member.id, ctx.now, row.id);
  const results = await env.db.batch([...(enrollment ? [enrollment] : []), update, audit]);
  return results.length === (enrollment ? 3 : 2) && results.every(result => result.meta.changes === 1);
}

/** Approval records the approving member and enrolls only that same member at their live authority. */
export async function handleDeviceApprove(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  const pending = pendingDevice(row.id, ctx.now);
  const roleRow = await env.db.prepare('SELECT role FROM members WHERE id = ?').bind(ctx.member.id).first<{ role: string }>();
  const role = asMemberRole(roleRow?.role);
  if (role === null) return deviceError('access_denied', 403);
  const { statement } = enrollmentInsert(env.db, ctx.now, row.expires_at - ctx.now, { kind: 'member', memberId: ctx.member.id },
    row.device_hash, row.id, role, ctx.member.id, null, pending);
  if (!await decideDevice(env, ctx, row, 'approved', statement)) return deviceError('approval_refused', 409);
  return Response.json({ approved: true });
}

/** A decision is single-use and attributed; an expired request receives no decision. */
export async function handleDeviceDeny(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  return await decideDevice(env, ctx, row, 'denied') ? Response.json({ denied: true }) : deviceError('request_finished', 409);
}
