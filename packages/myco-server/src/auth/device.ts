import { tryNameMemberFromLogin } from './members-admin.js';
import { AUTH_SETUP_CODES } from '@goondocks/myco-shared/member-protocol';
import { hasLinkedAdmin } from './identity-link.js';
import type { PreparedStatement, RelationalStore, ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { toBase64Url } from '../base64.js';
import { sha256Hex } from '../hash.js';
import { badRequest, readJsonObject } from '../api/scope.js';
import { enrollmentInsert, ENROLLMENT_KEY_BYTES, ENROLLMENT_KEY_PATTERN, ENROLLMENT_IDENTITY_PATTERN, type Fragment } from './enrollment.js';
import { joinMember } from './join.js';
import { asMemberRole } from './roles.js';
import { deploymentIdentity } from './authorization.js';
import { registerRunner, runnerOfRegistration, RUNNER_NAME_PATTERN, RUNNER_TOKEN_PATTERN } from './runners.js';

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
  subject: 'member' | 'runner';
  runner_name: string | null;
  replacing_runner_id: string | null;
}

/**
 * A device request a store carries into another instance — a member sign-in or a runner registration — admits no
 * decision there: an undecided one expires at the instant it arrives. Portable restore applies it to each carried row,
 * and recovery applies it to the recovered store as a whole.
 */
export function expireCarriedDeviceRequest(row: Record<string, unknown>, now: number): Record<string, unknown> {
  return row.decision === null && typeof row.expires_at === 'number' && row.expires_at > now ? { ...row, expires_at: now } : row;
}

/** `expireCarriedDeviceRequest` over every request a recovered store holds. */
export function expireCarriedDeviceRequests(db: RelationalStore, now: number): PreparedStatement {
  return db.prepare('UPDATE device_requests SET expires_at = ? WHERE decision IS NULL AND expires_at > ?').bind(now, now);
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
  return startDeviceRequest(env, request, now, source, { machineId: body.machineId, machineName: body.machineName, os: body.os, runner: null });
}

/**
 * Starts a runner registration: a device request of the runner subject, carrying the runner's name and the digest of
 * the bearer its client generated. The approval binds that digest; the bearer itself never reaches this store.
 */
export async function handleRunnerDeviceStart(env: ServerEnv, request: Request, now: number, source: string): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => !['name', 'machineId', 'machineName', 'os', 'candidate', 'replace', 'runnerId'].includes(k))
    || (body.replace !== undefined && typeof body.replace !== 'boolean')
    || (body.runnerId !== undefined && (body.replace !== true || typeof body.runnerId !== 'string' || !ENROLLMENT_IDENTITY_PATTERN.test(body.runnerId)))
    || typeof body.name !== 'string' || !RUNNER_NAME_PATTERN.test(body.name)
    || typeof body.machineId !== 'string' || !ENROLLMENT_IDENTITY_PATTERN.test(body.machineId) || !metadata(body.machineName) || !metadata(body.os)
    || typeof body.candidate !== 'string' || !RUNNER_TOKEN_PATTERN.test(body.candidate)) {
    return badRequest('name, machineId, machineName, os and candidate are required');
  }
  const targets = body.replace === true ? (await env.db.prepare(`SELECT id FROM runners WHERE name = ? AND state <> 'removed'
    ${body.runnerId === undefined ? '' : 'AND id = ?'} LIMIT 2`).bind(body.name, ...(body.runnerId === undefined ? [] : [body.runnerId])).all<{ id: string }>()).results : [];
  if (body.replace === true && targets.length !== 1) return deviceError(targets.length === 0 ? 'runner_not_found' : 'runner_name_ambiguous', 409);
  const candidateHash = await sha256Hex(body.candidate);
  const known = await env.db.prepare(`SELECT 1 AS one FROM device_requests WHERE candidate_hash = ?
    UNION ALL SELECT 1 FROM runner_credentials WHERE token_hash = ? LIMIT 1`).bind(candidateHash, candidateHash).first<{ one: number }>();
  if (known !== null) return badRequest('stage a fresh candidate');
  return startDeviceRequest(env, request, now, source, { machineId: body.machineId, machineName: body.machineName, os: body.os, runner: { name: body.name, candidateHash, replacingId: targets[0]?.id ?? null } });
}

/** One device request of either subject, admitted under the shared per-source bounds. */
async function startDeviceRequest(env: ServerEnv, request: Request, now: number, source: string,
  device: { machineId: string; machineName: string; os: string; runner: { name: string; candidateHash: string; replacingId: string | null } | null }): Promise<Response> {
  if (!await hasLinkedAdmin(env.db)) return deviceError(AUTH_SETUP_CODES.noOwner, 409);
  const deviceCode = toBase64Url(crypto.getRandomValues(new Uint8Array(ENROLLMENT_KEY_BYTES)));
  const userCode = newUserCode();
  const id = `en_device_${crypto.randomUUID()}`;
  const inserted = await env.db.prepare(`INSERT INTO device_requests
    (id,device_hash,user_hash,machine_id,machine_name,os,source_ip,created_at,expires_at,interval_seconds,next_poll_at,subject,runner_name,candidate_hash,replacing_runner_id)
    SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE
      NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ? AND decision IS NULL AND expires_at > ? LIMIT 1 OFFSET ?)
      AND NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ? AND created_at > ? LIMIT 1 OFFSET ?)`)
    .bind(id, await sha256Hex(deviceCode), await sha256Hex(userCode.replace('-', '')),
      device.machineId, device.machineName, device.os, source, now, now + DEVICE_TTL_MS, DEVICE_POLL_SECONDS, now,
      device.runner === null ? 'member' : 'runner', device.runner?.name ?? null, device.runner?.candidateHash ?? null, device.runner?.replacingId ?? null,
      source, now, DEVICE_PENDING_PER_SOURCE - 1, source, now - DEVICE_START_WINDOW_MS, DEVICE_STARTS_PER_MINUTE - 1).run();
  if (inserted.meta.changes !== 1) return deviceError('slow_down', 429, DEVICE_START_WINDOW_MS / 1000);
  const verificationUri = `${new URL(request.url).origin}/device`;
  return Response.json({ device_code: deviceCode, user_code: userCode, verification_uri: verificationUri, verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
    expires_in: DEVICE_TTL_MS / 1000, interval: DEVICE_POLL_SECONDS });
}

/** Polling cadence is advanced atomically, including each persistent RFC 8628 five-second slowdown. A runner request is never redeemed here. */
export async function handleDevicePoll(env: ServerEnv, request: Request, now: number): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => k !== 'device_code') || typeof body.device_code !== 'string' || !ENROLLMENT_KEY_PATTERN.test(body.device_code)) return deviceError('invalid_request');
  const hash = await sha256Hex(body.device_code);
  const row = await env.db.prepare(`SELECT d.*, a.used_at FROM device_requests d
    LEFT JOIN enrollment_authorities a ON a.id = d.id WHERE d.device_hash = ? AND d.subject = 'member'`).bind(hash).first<DeviceRow & { used_at: number | null }>();
  if (row === null || row.used_at !== null) return deviceError('invalid_grant');
  const paced = await pacePoll(env, row, hash, now);
  if (paced !== null) return paced;
  const joined = await joinMember(env, {
    key: body.device_code, machineId: row.machine_id, runtimeLabel: row.machine_name.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 64), runtimeKind: 'persistent',
  }, now);
  const answer = await joined.json() as Record<string, unknown>;
  if (answer.joined !== true) return deviceError(answer.code === 'identity_claimed' ? 'identity_claimed' : 'invalid_grant');
  return Response.json(answer);
}

/**
 * A runner registration's poll. The approval already committed the runner and bound its candidate, so an approved
 * request answers the runner it created, as often as it is asked, and mints nothing. A member request is never
 * answered here.
 */
export async function handleRunnerDevicePoll(env: ServerEnv, request: Request, now: number): Promise<Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => k !== 'device_code') || typeof body.device_code !== 'string' || !ENROLLMENT_KEY_PATTERN.test(body.device_code)) return deviceError('invalid_request');
  const hash = await sha256Hex(body.device_code);
  const row = await env.db.prepare(`SELECT * FROM device_requests WHERE device_hash = ? AND subject = 'runner'`).bind(hash).first<DeviceRow>();
  if (row === null) return deviceError('invalid_grant');
  const paced = await pacePoll(env, row, hash, now);
  if (paced !== null) return paced;
  const runner = await runnerOfRegistration(env.db, row.id);
  if (runner === null) return deviceError('invalid_grant');
  return Response.json({ registered: true, runnerId: runner.id, name: runner.name, deploymentId: await deploymentIdentity(env.db) });
}

/** The poll's answer while the request is not yet redeemable, or null once it is approved. */
async function pacePoll(env: ServerEnv, row: DeviceRow, hash: string, now: number): Promise<Response | null> {
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
  return null;
}

export async function requestByUserCode(env: ServerEnv, request: Request): Promise<DeviceRow | Response> {
  const body = await readJsonObject(request);
  if (body === null || Object.keys(body).some(k => k !== 'user_code') || typeof body.user_code !== 'string') return badRequest('user_code required');
  const code = body.user_code.trim().toUpperCase().replace('-', '');
  if (code.length !== USER_CODE_LENGTH || [...code].some(c => !USER_ALPHABET.includes(c))) return deviceError('invalid_user_code', 404);
  const row = await env.db.prepare('SELECT * FROM device_requests WHERE user_hash = ?').bind(await sha256Hex(code)).first<DeviceRow>();
  return row ?? deviceError('invalid_user_code', 404);
}

/** The dashboard sees requesting metadata and the request's subject — a membership or a runner and its name — never a device secret or digest. */
export async function handleDevicePreview(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  if (row.expires_at <= ctx.now) return deviceError('expired_token');
  if (row.decision !== null) return deviceError('request_finished', 409);
  const shared = { machineName: row.machine_name, os: row.os, ip: row.source_ip, approverIp: ctx.source,
    ageSeconds: Math.max(0, Math.floor((ctx.now - row.created_at) / 1000)), expiresAt: row.expires_at };
  if (row.subject === 'runner') return Response.json({ ...shared, subject: 'runner', runnerName: row.runner_name, replacingRunnerId: row.replacing_runner_id, scope: 'runner' });
  const claim = await env.db.prepare('SELECT member_id FROM machine_claims WHERE machine_id = ?').bind(row.machine_id).first<{ member_id: string }>();
  return Response.json({ ...shared, subject: 'member', alreadyYours: claim?.member_id === ctx.member.id, scope: 'membership' });
}

function pendingDevice(id: string, now: number, subject?: 'member'): Fragment {
  return { sql: `EXISTS (SELECT 1 FROM device_requests d WHERE d.id = ? AND d.decision IS NULL AND d.expires_at > ?${subject === undefined ? '' : ' AND d.subject = ?'}
    AND NOT EXISTS (SELECT 1 FROM device_decision_audit a WHERE a.request_id = d.id))`, params: [id, now, ...(subject === undefined ? [] : [subject])] };
}

/** A decision and its immutable audit receipt commit together; a pending request admits exactly one decision. */
async function decideDevice(env: ServerEnv, ctx: OwnerContext, row: DeviceRow, decision: 'approved' | 'denied', enrollment?: PreparedStatement): Promise<boolean> {
  const pending = pendingDevice(row.id, ctx.now, decision === 'approved' ? 'member' : undefined);
  const update = env.db.prepare(`UPDATE device_requests SET decision = ?, decided_by = ?, decided_at = ?
    WHERE id = ? AND ${pending.sql}
      AND EXISTS (SELECT 1 FROM members WHERE id = ? AND revoked_at IS NULL AND role IN ('admin','member'))
      ${decision === 'approved' ? 'AND EXISTS (SELECT 1 FROM enrollment_authorities WHERE id = ? AND created_by_member = ?)' : ''}`)
    .bind(decision, ctx.member.id, ctx.now, row.id, ...pending.params, ctx.member.id,
      ...(decision === 'approved' ? [row.id, ctx.member.id] : []));
  const audit = env.db.prepare(`INSERT INTO device_decision_audit (request_id,member_id,machine_id,machine_name,os,source_hash,decision,decided_at,subject)
    SELECT id,decided_by,machine_id,machine_name,os,?,decision,decided_at,subject FROM device_requests
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
  await tryNameMemberFromLogin(env.db, ctx.member.id, ctx.session.sub, ctx.session.login);
  const pending = pendingDevice(row.id, ctx.now, 'member');
  const roleRow = await env.db.prepare('SELECT role FROM members WHERE id = ?').bind(ctx.member.id).first<{ role: string }>();
  const role = asMemberRole(roleRow?.role);
  if (role === null) return deviceError('access_denied', 403);
  const { statement } = enrollmentInsert(env.db, ctx.now, row.expires_at - ctx.now, { kind: 'member', memberId: ctx.member.id },
    row.device_hash, row.id, role, ctx.member.id, null, pending);
  if (!await decideDevice(env, ctx, row, 'approved', statement)) return deviceError('approval_refused', 409);
  return Response.json({ approved: true });
}

/**
 * An owner or administrator registers the runner a pending runner request names: the runner and its first credential,
 * bound to the candidate digest the request carries, commit with the decision while the approver's standing holds.
 * A member request is never approved here.
 */
export async function handleRunnerDeviceApprove(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  const registered = await registerRunner(env.db, ctx.member.id, row.id, await sha256Hex(row.source_ip), ctx.now, row.replacing_runner_id ?? undefined);
  if (registered === null) return deviceError('approval_refused', 409);
  return Response.json({ approved: true, runnerId: registered.runnerId });
}

/** A decision is single-use and attributed; an expired request receives no decision. */
export async function handleDeviceDeny(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const row = await requestByUserCode(env, ctx.request);
  if (row instanceof Response) return row;
  return await decideDevice(env, ctx, row, 'denied') ? Response.json({ denied: true }) : deviceError('request_finished', 409);
}
