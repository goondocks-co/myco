/** The reasons a harness's own words can be read as, by the patterns its manifest declares. */
export const PATTERNED_DIAGNOSTIC_CODES = ['login_missing', 'rate_limited', 'model_refused', 'timed_out'] as const;

/**
 * Why a harness stopped with an error, as a code: one its words are read as (`PATTERNED_DIAGNOSTIC_CODES`); a process
 * that exited non-zero or on a signal with no other reason (`crashed`); one its driver knows from the stream's
 * structure (a granted call refused, the claimed profile unapplied, the run's tools unlisted, a session opened outside
 * the run's agent, a reply the protocol does not name, a launch that could not be prepared); or none of these
 * (`harness_error`).
 */
export const RUN_DIAGNOSTIC_CODES = [
  ...PATTERNED_DIAGNOSTIC_CODES,
  'crashed', 'permission_refused', 'profile_unapplied', 'tools_unlisted', 'tools_unused', 'session_unasked', 'protocol_error', 'launch_failed', 'harness_error',
] as const;
export type RunDiagnosticCode = (typeof RUN_DIAGNOSTIC_CODES)[number];
export type PatternedDiagnosticCode = (typeof PATTERNED_DIAGNOSTIC_CODES)[number];

/** A harness's error, coded: the reason, the exit code and signal where its process gave them, and the tools a refusal named. */
export interface RunDiagnostic {
  code: RunDiagnosticCode;
  exitCode?: number;
  signal?: string;
  names?: readonly string[];
}

/** A bounded diagnostic retained independently of the task outcome. */
export interface HarnessStop extends RunDiagnostic { detail?: string }

export const LATE_HARNESS_ERROR_NOTE = 'the agent session ended with an error after the work was done';
