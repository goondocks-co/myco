export const STALE_RUN_ERROR = 'the machine running it stopped responding';
export const STALE_PENDING_REASON = 'no machine started the task within a day';
export const LAUNCH_REFUSED_ERROR = 'the machine could not start the task';

/** How a run whose closing reports carry no audit is recorded (`core/run-postconditions.ts`). */
export const RUN_CLOSE_AUDIT_ERROR = 'the run ended without its audit';

export type RunErrorCode = 'machine_did_not_start' | 'machine_unresponsive' | 'task_start_failed' | 'model_not_applied' | 'report_without_audit' | 'run_failed';

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
  return 'run_failed';
}

/** A skipped run's known classifier, or a named fallback for free text. */
export function skipReasonCode(reason: string | null): string | null {
  if (reason === null) return null;
  if (reason === STALE_PENDING_REASON || reason === 'no runtime took the run within a day') return 'machine_did_not_start';
  return /^[a-z]+(?:_[a-z]+)+$/.test(reason) ? reason : 'run_not_needed';
}
