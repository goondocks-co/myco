import { runErrorDiagnostic } from '@goondocks/myco-shared/run-text';
import { type RunControlRefusalCode } from '@goondocks/myco-shared/run-control';
export const STALE_RUN_ERROR = 'the machine running it stopped responding';
export const STALE_PENDING_REASON = 'no machine started the task within a day';
export const LAUNCH_REFUSED_ERROR = 'the machine could not start the task';

/** How a run whose closing reports carry no audit is recorded (`core/run-postconditions.ts`). */
export const RUN_CLOSE_AUDIT_ERROR = 'the run ended without its audit';

export type RunErrorCode = RunControlRefusalCode | 'machine_did_not_start' | 'machine_unresponsive' | 'task_start_failed' | 'model_not_applied' | 'report_without_audit' | 'run_cancelled'
  | 'agent_not_signed_in' | 'agent_rate_limited' | 'agent_model_refused' | 'agent_timed_out' | 'agent_crashed'
  | 'agent_failed' | 'agent_launch_failed' | 'agent_protocol_error' | 'agent_permission_refused' | 'agent_tools_unlisted' | 'agent_tools_unused' | 'run_failed';

/** The reader code each harness diagnostic a reader can act on is recorded under; any other reads as `run_failed`. */
const DIAGNOSTIC_ERROR_CODES: Readonly<Record<string, RunErrorCode>> = {
  login_missing: 'agent_not_signed_in',
  rate_limited: 'agent_rate_limited',
  model_refused: 'agent_model_refused',
  timed_out: 'agent_timed_out',
  crashed: 'agent_crashed',
  harness_error: 'agent_failed',
  launch_failed: 'agent_launch_failed',
  protocol_error: 'agent_protocol_error',
  permission_refused: 'agent_permission_refused',
  tools_unlisted: 'agent_tools_unlisted',
  tools_unused: 'agent_tools_unused',
};

/** The code a run whose worker reported this error is recorded under: its diagnostic's reader code, or `run_failed`. */
export const diagnosticErrorCode = (error: string | null): RunErrorCode => DIAGNOSTIC_ERROR_CODES[runErrorDiagnostic(error) ?? ''] ?? 'run_failed';

/** The code a run that closed short of its task's rule is recorded under. */
export const closeErrorCode = (unmet: string): RunErrorCode => (unmet === RUN_CLOSE_AUDIT_ERROR ? 'report_without_audit' : 'run_failed');

/** Stored codes take precedence; text matching admits rows with no recorded code. */
export function runErrorCode(error: string | null, storedCode: string | null = null): string | null {
  if (storedCode !== null) return storedCode;
  if (error === null) return null;
  if (error === STALE_PENDING_REASON || error === 'no runtime took the run within a day' || /^no worker reporting .+ took the run within a day$/.test(error)) return 'machine_did_not_start';
  if (error === STALE_RUN_ERROR || error === 'the runtime went away') return 'machine_unresponsive';
  if (error.startsWith(LAUNCH_REFUSED_ERROR) || error.startsWith('the runtime refused to start')) return 'task_start_failed';
  if (error.startsWith(RUN_CLOSE_AUDIT_ERROR)) return 'report_without_audit';
  return diagnosticErrorCode(error);
}

/** A skipped run's known classifier, or a named fallback for free text. */
export function skipReasonCode(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === STALE_PENDING_REASON || reason === 'no runtime took the run within a day') return 'machine_did_not_start';
  return /^[a-z]+(?:_[a-z]+)+$/.test(reason) ? reason : 'run_not_needed';
}
