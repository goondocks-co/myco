import type { RelationalStore } from '../../core/adapters.js';
import { CONTACT_RECENT_MS } from '../../core/worker-contacts.js';
import { assertion, commit, first, read, refusalCode, refused, write, type Bound } from '../index.js';
import { liveRunnerAdminPredicate } from './registration.js';

export interface UpdateRequestRow { id: string; requestedAt: number }
const requestRead = read<[runner: string], UpdateRequestRow>({ name: 'runners.updateRequest', sql: 'SELECT id, requested_at AS requestedAt FROM runner_update_requests WHERE runner_id = ?1' });
export const runnerUpdateRequestRow = (db: RelationalStore, runnerId: string): Promise<UpdateRequestRow | null> => first(db, requestRead.bind(runnerId));

const clearReports = write<[runner: string]>({ name: 'runners.clearUpdateReports', sql: 'DELETE FROM runner_update_reports WHERE runner_id = ?1' });
const clearRequests = write<[runner: string]>({ name: 'runners.clearUpdateRequests', sql: 'DELETE FROM runner_update_requests WHERE runner_id = ?1' });
/** Update commands and machine reports belong to the credential epoch that received them. */
export const runnerUpdateInvalidations = (runnerId: string): readonly Bound[] => [clearReports.bind(runnerId), clearRequests.bind(runnerId)];

export interface ReportWrite { runner: string; channel: string | null; currentVersion: string; latestVersion: string | null; lastCheckAt: number | null; metadata: string; observedOrder: number }
const putReport = write<[runner: string, channel: string | null, current: string, latest: string | null, checkedAt: number | null, metadata: string, order: number]>({ name: 'runners.putUpdateReport', sql:
  `INSERT INTO runner_update_reports (runner_id, channel, current_version, latest_version, last_check_at, last_result, observed_order)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT(runner_id) DO UPDATE SET channel = excluded.channel, current_version = excluded.current_version,
      latest_version = excluded.latest_version, last_check_at = excluded.last_check_at, last_result = excluded.last_result, observed_order = excluded.observed_order
    WHERE excluded.observed_order IS NOT NULL AND (runner_update_reports.observed_order IS NULL OR excluded.observed_order > runner_update_reports.observed_order)` });
export const runnerUpdateReportWrite = (report: ReportWrite): Bound =>
  putReport.bind(report.runner, report.channel, report.currentVersion, report.latestVersion, report.lastCheckAt, report.metadata, report.observedOrder);

const auditReported = write<[id: string, runner: string, request: string | null, detail: string, at: number]>({ name: 'runners.auditUpdateReported', sql:
  `INSERT OR IGNORE INTO runner_update_audit (id, runner_id, actor_member, action, request_id, detail, at) VALUES (?1, ?2, NULL, 'reported', ?3, ?4, ?5)` });
export const runnerUpdateAuditWrite = (id: string, runner: string, request: string | null, detail: string, at: number): Bound => auditReported.bind(id, runner, request, detail, at);

const finishRequest = write<[runner: string, request: string]>({ name: 'runners.finishUpdateRequest', sql: 'DELETE FROM runner_update_requests WHERE runner_id = ?1 AND id = ?2' });
export const runnerUpdateRequestFinish = (runner: string, request: string): Bound => finishRequest.bind(runner, request);

const receiptRead = read<[runner: string, order: number | null, channel: string | null, current: string, latest: string | null, checkedAt: number | null, metadata: string], { observed_order: number | null; matches: number }>({ name: 'runners.updateReceipt', sql:
  `SELECT observed_order, (observed_order IS ?2 AND channel IS ?3 AND current_version IS ?4 AND latest_version IS ?5 AND last_check_at IS ?6 AND last_result IS ?7) AS matches
    FROM runner_update_reports WHERE runner_id = ?1` });
export const runnerUpdateReceiptRow = (db: RelationalStore, runner: string, report: Omit<ReportWrite, 'runner' | 'observedOrder'> & { observedOrder: number | null }) =>
  first(db, receiptRead.bind(runner, report.observedOrder, report.channel, report.currentVersion, report.latestVersion, report.lastCheckAt, report.metadata));

const updateTarget = read<[runner: string], { state: string; lastSeenAt: number | null; channel: string | null }>({ name: 'runners.updateTarget', sql:
  `SELECT r.state, c.last_seen_at AS lastSeenAt, u.channel FROM runners r LEFT JOIN runner_contacts c ON c.runner_id = r.id
    LEFT JOIN runner_update_reports u ON u.runner_id = r.id WHERE r.id = ?1` });
export const runnerUpdateTarget = (db: RelationalStore, runnerId: string) => first(db, updateTarget.bind(runnerId));

const refusedRequest = refusalCode('myco_runner_update_refused');
const reachable = assertion<[actor: string, runner: string, since: number]>({ name: 'runners.updateReachable', refusal: refusedRequest,
  when: `${liveRunnerAdminPredicate('?1')} AND EXISTS (SELECT 1 FROM runners r JOIN runner_contacts c ON c.runner_id = r.id
    JOIN runner_update_reports u ON u.runner_id = r.id AND u.channel IS NOT NULL WHERE r.id = ?2 AND r.state <> 'removed' AND c.last_seen_at >= ?3)` });
const putRequest = write<[runner: string, id: string, now: number]>({ name: 'runners.putUpdateRequest', sql: 'INSERT OR IGNORE INTO runner_update_requests (runner_id, id, requested_at) VALUES (?1, ?2, ?3)' });
const auditRequested = write<[id: string, actor: string, now: number, runner: string]>({ name: 'runners.auditUpdateRequested', sql:
  `INSERT INTO runner_update_audit (id, runner_id, actor_member, action, request_id, detail, at)
    SELECT ?1, runner_id, ?2, 'requested', id, '{"target":"check_now"}', ?3 FROM runner_update_requests WHERE runner_id = ?4` });

/** One administrator request against the runner's single pending command. Answers false when the actor or the runner no longer admits it. */
export async function commitRunnerUpdateRequest(db: RelationalStore, request: { id: string; actor: string; runner: string; now: number }): Promise<boolean> {
  try {
    await commit(db, reachable.bind(request.actor, request.runner, request.now - CONTACT_RECENT_MS), putRequest.bind(request.runner, request.id, request.now),
      auditRequested.bind(request.id, request.actor, request.now, request.runner));
    return true;
  } catch (error) {
    if (refused(error, refusedRequest)) return false;
    throw error;
  }
}
