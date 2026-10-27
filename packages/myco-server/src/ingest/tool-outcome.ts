export interface OutcomeSource {
  ordinal: number;
  offset: number;
  origin: 'synthetic' | 'reported';
}
export interface ToolAssembly {
  values: Record<string, unknown>;
  call: OutcomeSource | null;
  outcome: OutcomeSource;
}
const order = (a: OutcomeSource, b: OutcomeSource) => a.ordinal - b.ordinal || a.offset - b.offset;
const callFields = [
  'tool_name',
  'input',
  'input_blob_key',
  'input_bytes',
  'prompt_id',
  'created_at',
  'myco_tool',
  'myco_op',
  'files_affected',
  'canopy_injection_tokens',
] as const;
const outcomeFields = [
  'success',
  'error_message',
  'result_reason',
  'output_preview',
  'output_blob_key',
  'duration_ms',
] as const;

/** Call metadata and reported outcomes have independent canonical source order. */
export function assembleToolOutcome(prior: ToolAssembly | null, incoming: ToolAssembly): ToolAssembly {
  if (prior === null) return incoming;
  const values = { ...prior.values };
  const call = prior.call ?? incoming.call;
  if (prior.call === null && incoming.call !== null)
    for (const key of callFields) values[key] = incoming.values[key] ?? null;
  const takes =
    incoming.outcome.origin === 'reported'
      ? prior.outcome.origin === 'synthetic' || order(incoming.outcome, prior.outcome) >= 0
      : prior.outcome.origin === 'synthetic' && order(incoming.outcome, prior.outcome) >= 0;
  if (takes) for (const key of outcomeFields) values[key] = incoming.values[key] ?? null;
  return { values, call, outcome: takes ? incoming.outcome : prior.outcome };
}
