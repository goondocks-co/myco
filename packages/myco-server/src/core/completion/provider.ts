/** One bounded, non-streaming OpenAI-shaped completion. */
export const COMPLETION_MODEL_CHARS = 256;
export const COMPLETION_BASE_URL_CHARS = 2048;
export const DIRECT_TITLE_BUDGET_MS = 25_000;
export const DIRECT_TITLE_SETTLEMENT_MS = 5_000;
export const COMPLETION_TIMEOUT_MS = 30_000;
export const COMPLETION_OUTPUT_TOKENS = 3_000;
export const DIRECT_CALL_WINDOW_MS = 60_000;
export const DIRECT_CALLS_PER_MINUTE = 10;
export const COMPLETION_ATTEMPTS = 2;
export const DEFAULT_COMPLETION_MODEL = '@cf/openai/gpt-oss-20b';

export interface CompletionRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  schema?: Record<string, unknown>;
  timeoutMs?: number;
}
export interface CompletionAnswer {
  text: string;
  usage: { input: number; output: number } | null;
}
export interface CompletionProvider {
  model: string;
  complete(request: CompletionRequest): Promise<CompletionAnswer>;
}
export type CompletionFailure = 'rate_limited' | 'timeout' | 'unreachable' | 'http' | 'invalid_response' | 'invalid_answer';
export class CompletionUnavailable extends Error {
  constructor(readonly code: CompletionFailure, readonly status?: number) {
    super(`completion_${code}${status === undefined ? '' : ` (HTTP ${status})`}`);
  }
}

/** The schema format served by OpenAI-compatible endpoints. */
export const completionInput = (request: CompletionRequest) => ({
  messages: request.messages, max_tokens: COMPLETION_OUTPUT_TOKENS, stream: false,
  ...(request.schema === undefined ? {} : { response_format: { type: 'json_schema', json_schema: { name: 'response', strict: true, schema: request.schema } } }),
});

/** Provider words and reasoning never become the answer or an error message. */
export function completionAnswer(body: unknown): CompletionAnswer {
  const held = body as { choices?: { message?: { content?: unknown } }[]; response?: unknown; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } } | null;
  const content = held?.choices?.[0]?.message?.content ?? held?.response;
  const text = content !== null && typeof content === 'object' && !Array.isArray(content) ? JSON.stringify(content) : content;
  if (typeof text !== 'string') throw new CompletionUnavailable('invalid_response');
  const input = held?.usage?.prompt_tokens;
  const output = held?.usage?.completion_tokens;
  const valid = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
  return { text, usage: valid(input) && valid(output) ? { input, output } : null };
}

/** An abort deadline covers the provider request and reading its answer. */
export async function boundedCompletion(work: (signal: AbortSignal) => Promise<unknown>, timeoutMs = COMPLETION_TIMEOUT_MS): Promise<CompletionAnswer> {
  const signal = AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, COMPLETION_TIMEOUT_MS)));
  try {
    const body = await work(signal);
    signal.throwIfAborted();
    return completionAnswer(body);
  } catch (error) {
    if (signal.aborted) throw new CompletionUnavailable('timeout');
    if (error instanceof CompletionUnavailable) throw error;
    throw new CompletionUnavailable('unreachable');
  }
}

/** Published USD per million tokens; models absent from this catalogue have unknown cost. */
export const COMPLETION_PRICES: Readonly<Record<string, { input: number; output: number }>> = {
  [DEFAULT_COMPLETION_MODEL]: { input: 0.20, output: 0.30 },
};
export function completionCost(model: string, usage: CompletionAnswer['usage']): number | null {
  const price = COMPLETION_PRICES[model];
  return price === undefined || usage === null ? null : (usage.input * price.input + usage.output * price.output) / 1_000_000;
}


/** Direct-call evidence uses the shared identity shape without a runner attempt. */
export function completionAccounting(model: string, usage: CompletionAnswer['usage'], unknownAttempts = 0) {
  return JSON.stringify({
    identity: { status: 'reported', source: 'deployment_direct_call', primary: { model, provider: 'direct' },
      models: [{ model, provider: 'direct', source: 'deployment_direct_call', usage: null }] },
    usage, usageComplete: unknownAttempts === 0, unknownAttempts, costProvenance: completionCost(model, usage) === null ? 'unavailable' : 'model_pricing',
  });
}
