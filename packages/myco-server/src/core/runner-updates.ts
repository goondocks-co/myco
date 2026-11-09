import { isReportOrder } from '@goondocks/myco-shared/report-order';
import type { RelationalStore } from './adapters.js';
import { CONTACT_RECENT_MS } from './worker-contacts.js';
import { sha256Hex } from '../hash.js';
import type { Bound } from '../db/index.js';
import { commitRunnerUpdateRequest, runnerUpdateAuditWrite, runnerUpdateReceiptRow, runnerUpdateReportWrite, runnerUpdateRequestFinish, runnerUpdateRequestRow, runnerUpdateTarget } from '../db/runners/updates.js';

import { RUNNER_UPDATE_RESULTS, isRunnerUpdateText, sanitizeRunnerUpdateReason, type RunnerUpdateResult, type RunnerUpdateReport, type RunnerUpdateRequest } from '@goondocks/myco-shared/runner-update';

const MAX_VERSION = 64;
const MAX_ID = 64;
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
type RunnerUpdateMetadataIssue = { field: 'update' | 'lastResult' | 'blockedVersion' | 'updateState'; disposition: 'dropped' | 'sanitized' };

/** Update metadata never determines whether the runner may contact or execute work. */
export function parseRunnerUpdateReport(value: unknown, issue: (issue: RunnerUpdateMetadataIssue) => void = () => {}): RunnerUpdateReport | null {
  if (!object(value) || !(value.channel === null || value.channel === 'stable' || value.channel === 'beta' || value.channel === 'alpha') || !isRunnerUpdateText(value.currentVersion, MAX_VERSION)
    || !(value.latestVersion === null || isRunnerUpdateText(value.latestVersion, MAX_VERSION))
    || !(value.lastCheckAt === null || timestamp(value.lastCheckAt))
    || (value.observedOrder !== undefined && !isReportOrder(value.observedOrder))) {
    issue({ field: 'update', disposition: 'dropped' });
    return null;
  }
  const report: RunnerUpdateReport = { channel: value.channel as RunnerUpdateReport['channel'], currentVersion: value.currentVersion,
    latestVersion: value.latestVersion as string | null, lastCheckAt: value.lastCheckAt,
    ...(value.observedOrder === undefined ? {} : { observedOrder: value.observedOrder as number }) };
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

/** One metadata envelope carries the result and holds from one observation. */
const RUNNER_UPDATE_REPORT_FORMAT = 'runner-update-report/1';
export async function readRunnerUpdateRequest(db: RelationalStore, runnerId: string): Promise<RunnerUpdateRequest | null> {
  const request = await runnerUpdateRequestRow(db, runnerId);
  return request === null ? null : { ...request, clearBlock: true };
}

const reportMetadata = (report: RunnerUpdateReport): string => JSON.stringify({
  format: RUNNER_UPDATE_REPORT_FORMAT, lastResult: report.lastResult ?? null,
  blockedVersion: report.blockedVersion ?? null, updateState: report.updateState ?? null,
});

/** The contact's metadata, one immutable outcome receipt, and the matching command acknowledgment commit together. */
export async function runnerUpdateReportStatements(runnerId: string, report: RunnerUpdateReport): Promise<Bound[]> {
  const result = report.lastResult;
  const statements: Bound[] = isReportOrder(report.observedOrder) ? [runnerUpdateReportWrite({ runner: runnerId, channel: report.channel, currentVersion: report.currentVersion,
    latestVersion: report.latestVersion, lastCheckAt: report.lastCheckAt, metadata: reportMetadata(report), observedOrder: report.observedOrder })] : [];
  if (result !== undefined) {
    const id = await sha256Hex(JSON.stringify(result.attemptId === undefined
      ? [runnerId, result.requestId ?? null, result.at, result.fromVersion, result.toVersion, result.result]
      : [runnerId, result.attemptId, result.fromVersion, result.toVersion, result.result]));
    statements.push(runnerUpdateAuditWrite(id, runnerId, result.requestId ?? null, JSON.stringify(result), result.at));
    if (result.requestId !== undefined) statements.push(runnerUpdateRequestFinish(runnerId, result.requestId));
  }
  return statements;
}

/** An unchanged retry is acknowledged from the stored observation without replacing it. */
export async function readRunnerUpdateReceipt(db: RelationalStore, runnerId: string, report: RunnerUpdateReport): Promise<{ updateRecorded: boolean; observedOrder: number | null }> {
  const row = await runnerUpdateReceiptRow(db, runnerId, { observedOrder: report.observedOrder ?? null, channel: report.channel, currentVersion: report.currentVersion,
    latestVersion: report.latestVersion, lastCheckAt: report.lastCheckAt, metadata: reportMetadata(report) });
  return { updateRecorded: isReportOrder(report.observedOrder) && row?.matches === 1, observedOrder: row?.observed_order ?? null };
}

type RequestRunnerUpdateOutcome = { requested: true; updateRequest: RunnerUpdateRequest } | { requested: false; code: 'not_found' | 'disconnected' | 'unsupported_channel' | 'refused' };

/** Each accepted administrator request records its actor against the runner's one pending command. */
export async function requestRunnerUpdate(db: RelationalStore, actorId: string, runnerId: string, now: number): Promise<RequestRunnerUpdateOutcome> {
  const runner = await runnerUpdateTarget(db, runnerId);
  if (runner === null || runner.state === 'removed') return { requested: false, code: 'not_found' };
  if (runner.lastSeenAt === null || runner.lastSeenAt < now - CONTACT_RECENT_MS) return { requested: false, code: 'disconnected' };
  if (runner.channel === null) return { requested: false, code: 'unsupported_channel' };
  if (!await commitRunnerUpdateRequest(db, { id: crypto.randomUUID(), actor: actorId, runner: runnerId, now })) return { requested: false, code: 'refused' };
  const request = await readRunnerUpdateRequest(db, runnerId);
  if (request === null) throw new Error('a committed update request has no row');
  return { requested: true, updateRequest: request };
}
