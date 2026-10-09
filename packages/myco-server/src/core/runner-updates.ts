import type { PreparedStatement, RelationalStore } from './adapters.js';
import { LIVE_RUNNER_ADMIN } from '../auth/runners.js';
import { CONTACT_RECENT_MS } from './worker-contacts.js';
import { writeGuardBatch } from './write-guard-store.js';
import { sha256Hex } from '../hash.js';

const UPDATE_RESULTS = ['updated', 'no_update', 'refused', 'rolled_back', 'failed'] as const;
export interface RunnerUpdateResult {
  requestId?: string;
  fromVersion: string;
  toVersion: string;
  result: (typeof UPDATE_RESULTS)[number];
  reason?: string;
  at: number;
}
export interface RunnerUpdateReport {
  channel: 'stable' | 'beta' | 'alpha' | null;
  currentVersion: string;
  latestVersion: string | null;
  lastCheckAt: number | null;
  lastResult?: RunnerUpdateResult;
}
export interface RunnerUpdateRequest { id: string; requestedAt: number }
const MAX_VERSION = 64;
const MAX_REASON = 512;
const MAX_REQUEST_ID = 64;
const boundedText = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Only bounded, explicit update metadata reaches storage. */
export function parseRunnerUpdateReport(value: unknown): RunnerUpdateReport | null {
  if (!object(value) || !(value.channel === null || ['stable', 'beta', 'alpha'].includes(String(value.channel))) || !boundedText(value.currentVersion, MAX_VERSION)
    || !(value.latestVersion === null || boundedText(value.latestVersion, MAX_VERSION))
    || !(value.lastCheckAt === null || timestamp(value.lastCheckAt))) return null;
  let lastResult: RunnerUpdateResult | undefined;
  if (value.lastResult !== undefined && value.lastResult !== null) {
    const result = value.lastResult;
    if (!object(result) || !boundedText(result.fromVersion, MAX_VERSION) || !boundedText(result.toVersion, MAX_VERSION)
      || !UPDATE_RESULTS.includes(result.result as RunnerUpdateResult['result']) || !timestamp(result.at)
      || (result.requestId !== undefined && !boundedText(result.requestId, MAX_REQUEST_ID))
      || (result.reason !== undefined && !boundedText(result.reason, MAX_REASON))) return null;
    lastResult = { fromVersion: result.fromVersion, toVersion: result.toVersion, result: result.result as RunnerUpdateResult['result'], at: result.at,
      ...(result.requestId === undefined ? {} : { requestId: result.requestId as string }), ...(result.reason === undefined ? {} : { reason: result.reason as string }) };
  }
  return { channel: value.channel as RunnerUpdateReport['channel'], currentVersion: value.currentVersion, latestVersion: value.latestVersion as string | null,
    lastCheckAt: value.lastCheckAt, ...(lastResult === undefined ? {} : { lastResult }) };
}

export async function readRunnerUpdateRequest(db: RelationalStore, runnerId: string): Promise<RunnerUpdateRequest | null> {
  return db.prepare('SELECT id, requested_at AS requestedAt FROM runner_update_requests WHERE runner_id = ?').bind(runnerId).first<RunnerUpdateRequest>();
}

/** The contact's metadata, one immutable outcome receipt, and the matching command acknowledgment commit together. */
export async function runnerUpdateReportStatements(db: RelationalStore, runnerId: string, report: RunnerUpdateReport): Promise<PreparedStatement[]> {
  const result = report.lastResult;
  const statements = [db.prepare(`INSERT INTO runner_update_reports (runner_id, channel, current_version, latest_version, last_check_at, last_result)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runner_id) DO UPDATE SET channel = excluded.channel, current_version = excluded.current_version,
      latest_version = excluded.latest_version, last_check_at = excluded.last_check_at,
      last_result = CASE WHEN excluded.last_result IS NOT NULL AND (runner_update_reports.last_result IS NULL
        OR json_extract(excluded.last_result, '$.at') >= json_extract(runner_update_reports.last_result, '$.at'))
        THEN excluded.last_result ELSE runner_update_reports.last_result END`)
    .bind(runnerId, report.channel, report.currentVersion, report.latestVersion, report.lastCheckAt, result === undefined ? null : JSON.stringify(result))];
  if (result !== undefined) {
    const id = await sha256Hex(JSON.stringify([runnerId, result.requestId ?? null, result.at, result.fromVersion, result.toVersion, result.result]));
    statements.push(db.prepare(`INSERT OR IGNORE INTO runner_update_audit (id, runner_id, actor_member, action, request_id, detail, at)
      VALUES (?, ?, NULL, 'reported', ?, ?, ?)`).bind(id, runnerId, result.requestId ?? null, JSON.stringify(result), result.at));
    if (result.requestId !== undefined) statements.push(db.prepare('DELETE FROM runner_update_requests WHERE runner_id = ? AND id = ?').bind(runnerId, result.requestId));
  }
  return statements;
}

const UPDATE_REFUSED = '$[myco_runner_update_refused]';
export type RequestRunnerUpdateOutcome = { requested: true; updateRequest: RunnerUpdateRequest } | { requested: false; code: 'not_found' | 'disconnected' | 'unsupported_channel' | 'refused' };

/** Each accepted administrator request records its actor against the runner's one pending command. */
export async function requestRunnerUpdate(db: RelationalStore, actorId: string, runnerId: string, now: number): Promise<RequestRunnerUpdateOutcome> {
  const runner = await db.prepare(`SELECT r.state, c.last_seen_at AS lastSeenAt, u.channel FROM runners r LEFT JOIN runner_contacts c ON c.runner_id = r.id
    LEFT JOIN runner_update_reports u ON u.runner_id = r.id WHERE r.id = ?`)
    .bind(runnerId).first<{ state: string; lastSeenAt: number | null; channel: string | null }>();
  if (runner === null || runner.state === 'removed') return { requested: false, code: 'not_found' };
  if (runner.lastSeenAt === null || runner.lastSeenAt < now - CONTACT_RECENT_MS) return { requested: false, code: 'disconnected' };
  if (runner.channel === null) return { requested: false, code: 'unsupported_channel' };
  const id = crypto.randomUUID();
  const assertion = () => db.prepare(`SELECT CASE WHEN ${LIVE_RUNNER_ADMIN} AND EXISTS
    (SELECT 1 FROM runners r JOIN runner_contacts c ON c.runner_id = r.id
      JOIN runner_update_reports u ON u.runner_id = r.id AND u.channel IS NOT NULL WHERE r.id = ? AND r.state <> 'removed' AND c.last_seen_at >= ?)
    THEN 1 ELSE json_extract('[]', ?) END AS admitted`).bind(actorId, runnerId, now - CONTACT_RECENT_MS, UPDATE_REFUSED);
  try {
    await writeGuardBatch(db, assertion, (error) => { throw error; }, [
      db.prepare(`INSERT OR IGNORE INTO runner_update_requests (runner_id, id, requested_at) VALUES (?, ?, ?)`).bind(runnerId, id, now),
      db.prepare(`INSERT INTO runner_update_audit (id, runner_id, actor_member, action, request_id, detail, at)
        SELECT ?, runner_id, ?, 'requested', id, '{"target":"check_now"}', ? FROM runner_update_requests WHERE runner_id = ?`)
        .bind(id, actorId, now, runnerId),
    ]);
  } catch (error) {
    if (error instanceof Error && error.message.includes(UPDATE_REFUSED.slice(1))) return { requested: false, code: 'refused' };
    throw error;
  }
  const request = await readRunnerUpdateRequest(db, runnerId);
  if (request === null) throw new Error('a committed update request has no row');
  return { requested: true, updateRequest: request };
}
