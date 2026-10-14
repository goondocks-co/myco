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
export const HARNESS_STOP_FIELD_VALUES = {
  subtype: ['success', 'error_during_execution', 'error_max_turns', 'error_max_budget_usd', 'error_max_structured_output_retries'],
  terminal_reason: ['blocking_limit', 'rapid_refill_breaker', 'prompt_too_long', 'image_error', 'model_error', 'api_error', 'malformed_tool_use_exhausted', 'aborted_streaming', 'aborted_tools', 'stop_hook_prevented', 'hook_stopped', 'tool_deferred', 'max_turns', 'background_requested', 'completed', 'budget_exhausted', 'structured_output_retry_exhausted', 'tool_deferred_unavailable', 'turn_setup_failed'],
  stop_reason: ['end_turn', 'max_tokens', 'max_turns', 'max_turn_requests', 'refusal', 'cancelled', 'error', 'tool_use', 'pause_turn', 'stop_sequence', 'model_context_window_exceeded'],
  status: ['completed', 'failed'],
} as const;
export type HarnessStopFields = Partial<Record<keyof typeof HARNESS_STOP_FIELD_VALUES, string>>;
export interface HarnessStop extends RunDiagnostic { fields?: HarnessStopFields }

const DIAGNOSTIC_READER_CODES = {
  login_missing: 'agent_not_signed_in', rate_limited: 'agent_rate_limited', model_refused: 'agent_model_refused',
  timed_out: 'agent_timed_out', crashed: 'agent_crashed', harness_error: 'agent_failed', launch_failed: 'agent_launch_failed',
  protocol_error: 'agent_protocol_error', permission_refused: 'agent_permission_refused', tools_unlisted: 'agent_tools_unlisted', tools_unused: 'agent_tools_unused',
} as const;
type DiagnosticReaderCode = (typeof DIAGNOSTIC_READER_CODES)[keyof typeof DIAGNOSTIC_READER_CODES] | 'run_failed';
/** Reader codes shared by task failures and late session diagnostics. */
export const diagnosticReaderCode = (code: string | null): DiagnosticReaderCode =>
  (DIAGNOSTIC_READER_CODES as Readonly<Record<string, DiagnosticReaderCode>>)[code ?? ''] ?? 'run_failed';

export const LATE_HARNESS_ERROR_NOTE = 'the agent session ended with an error after the work was done';
