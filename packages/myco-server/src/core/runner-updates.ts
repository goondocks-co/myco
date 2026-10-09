import type { PreparedStatement, RelationalStore } from './adapters.js';
import { LIVE_RUNNER_ADMIN } from '../auth/runners.js';
import { CONTACT_RECENT_MS } from './worker-contacts.js';
import { writeGuardBatch } from './write-guard-store.js';
import { sha256Hex } from '../hash.js';

export type { RunnerUpdateResult, RunnerUpdateReport, RunnerUpdateRequest } from '@goondocks/myco-shared/runner-update';
import { RUNNER_UPDATE_RESULTS, isRunnerUpdateText, sanitizeRunnerUpdateReason, type RunnerUpdateResult, type RunnerUpdateReport, type RunnerUpdateRequest } from '@goondocks/myco-shared/runner-update';

const MAX_VERSION = 64;
const MAX_ID = 64;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
export type RunnerUpdateMetadataIssue = { field: 'update' | 'lastResult' | 'blockedVersion' | 'updateState'; disposition: 'dropped' | 'sanitized' };

/** Update metadata never determines whether the runner may contact or execute work. */
export function parseRunnerUpdateReport(value: unknown, issue: (issue: RunnerUpdateMetadataIssue) => void = () => {}): RunnerUpdateReport | null {
  if (!object(value) || !(value.channel === null || value.channel === 'stable' || value.channel === 'beta' || value.channel === 'alpha') || !isRunnerUpdateText(value.currentVersion, MAX_VERSION)
    || !(value.latestVersion === null || isRunnerUpdateText(value.latestVersion, MAX_VERSION))
    || !(value.lastCheckAt === null || timestamp(value.lastCheckAt))) {
    issue({ field: 'update', disposition: 'dropped' });
    return null;
  }
  const report: RunnerUpdateReport = { channel: value.channel as RunnerUpdateReport['channel'], currentVersion: value.currentVersion,
    latestVersion: value.latestVersion as string | null, lastCheckAt: value.lastCheckAt };
  const reason = (text: string, field: RunnerUpdateMetadataIssue['field']) => {
    const sanitized = sanitizeRunnerUpdateReason(text);
    if (text !== sanitized) issue({ field, disposition: 'sanitized' });
    return sanitized;
  };
  if (value.lastResult !== undefined && value.lastResult !== null) {
    const result = value.lastResult;
    if (!object(result) || !isRunnerUpdateText(result.fromVersion, MAX_VERSION) || !isRunnerUpdateText(result.toVersion, MAX_VERSION)
      || !RUNNER_UPDATE_RESULTS.includes(result.result as RunnerUpdateResult['result']) || !timestamp(result.at)
      || (result.requestId !== undefined && !isRunnerUpdateText(result.requestId, MAX_ID))
      || (result.attemptId !== undefined && !isRunnerUpdateText(result.attemptId, MAX_ID))
      || (result.reason !== undefined && typeof result.reason !== 'string')) issue({ field: 'lastResult', disposition: 'dropped' });
    else report.lastResult = { fromVersion: result.fromVersion, toVersion: result.toVersion, result: result.result as RunnerUpdateResult['result'], at: result.at,
      ...(result.requestId === undefined ? {} : { requestId: result.requestId as string }),
      ...(result.attemptId === undefined ? {} : { attemptId: result.attemptId as string }),
      ...(result.reason === undefined ? {} : { reason: reason(result.reason as string, 'lastResult') }) };
  }
  if (value.blockedVersion !== undefined && value.blockedVersion !== null) {
    const block = value.blockedVersion;
    if (!object(block) || !isRunnerUpdateText(block.version, MAX_VERSION) || !timestamp(block.until) || typeof block.reason !== 'string') issue({ field: 'blockedVersion', disposition: 'dropped' });
    else report.blockedVersion = { version: block.version, until: block.until, reason: reason(block.reason, 'blockedVersion') };
  }
  if (value.updateState !== undefined && value.updateState !== null) {
    const state = value.updateState;
    if (!object(state) || !(state.phase === 'updating' || state.phase === 'probation' || state.phase === 'cleanup_pending') || !timestamp(state.since)
      || (state.reason !== undefined && typeof state.reason !== 'string')) issue({ field: 'updateState', disposition: 'dropped' });
    else report.updateState = { phase: state.phase as NonNullable<RunnerUpdateReport['updateState']>['phase'], since: state.since,
      ...(state.reason === undefined ? {} : { reason: reason(state.reason as string, 'updateState') }) };
  }
  return report;
}

/** One metadata envelope carries current holds independently of the newest outcome receipt. */
export const RUNNER_UPDATE_REPORT_FORMAT = 'runner-update-report/1';
const STORED_RESULT = `CASE WHEN json_extract(runner_update_reports.last_result, '$.format') = '${RUNNER_UPDATE_REPORT_FORMAT}'
  THEN json_extract(runner_update_reports.last_result, '$.lastResult') ELSE runner_update_reports.last_result END`;

export async function readRunnerUpdateRequest(db: RelationalStore, runnerId: string): Promise<RunnerUpdateRequest | null> {
  const request = await db.prepare('SELECT id, requested_at AS requestedAt FROM runner_update_requests WHERE runner_id = ?').bind(runnerId).first<Omit<RunnerUpdateRequest, 'clearBlock'>>();
  return request === null ? null : { ...request, clearBlock: true };
}

/** The contact's metadata, one immutable outcome receipt, and the matching command acknowledgment commit together. */
export async function runnerUpdateReportStatements(db: RelationalStore, runnerId: string, report: RunnerUpdateReport): Promise<PreparedStatement[]> {
  const result = report.lastResult;
  const statements = [db.prepare(`INSERT INTO runner_update_reports (runner_id, channel, current_version, latest_version, last_check_at, last_result)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(runner_id) DO UPDATE SET channel = excluded.channel, current_version = excluded.current_version,
      latest_version = excluded.latest_version, last_check_at = excluded.last_check_at,
      last_result = json_set(excluded.last_result, '$.lastResult', json(CASE
        WHEN json_extract(excluded.last_result, '$.lastResult') IS NOT NULL AND ((${STORED_RESULT}) IS NULL
          OR json_extract(excluded.last_result, '$.lastResult.at') >= json_extract((${STORED_RESULT}), '$.at'))
        THEN json_extract(excluded.last_result, '$.lastResult') ELSE (${STORED_RESULT}) END))`)
    .bind(runnerId, report.channel, report.currentVersion, report.latestVersion, report.lastCheckAt,
      JSON.stringify({ format: RUNNER_UPDATE_REPORT_FORMAT, lastResult: result ?? null, blockedVersion: report.blockedVersion ?? null, updateState: report.updateState ?? null }))];
  if (result !== undefined) {
    const id = await sha256Hex(JSON.stringify(result.attemptId === undefined
      ? [runnerId, result.requestId ?? null, result.at, result.fromVersion, result.toVersion, result.result]
      : [runnerId, result.attemptId, result.fromVersion, result.toVersion, result.result]));
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
