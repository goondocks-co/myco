/**
 * Error classification for pipeline retry and circuit-breaker decisions.
 *
 * classifyError() inspects an error and returns:
 *   - type: 'transient' | 'config' | 'parse'
 *   - suggestedAction: human-readable hint for config/parse errors (displayed in dashboard)
 *
 * Priority order (highest to lowest):
 *   1. parse  — SyntaxError, name='ParseError', empty content, schema validation
 *   2. config — ECONNREFUSED, 401, 403, model not found/loaded, resource exhaustion
 *   3. config — ENOTFOUND matching configuredHost
 *   4. transient — AbortError, ETIMEDOUT, ECONNRESET, 429, 500, 503, socket hang up
 *   5. transient — ENOTFOUND for well-known API hosts
 *   6. transient — fallback for all unrecognised errors
 */

export type ErrorType = 'transient' | 'config' | 'parse';

export interface ClassifyResult {
  type: ErrorType;
  suggestedAction?: string;
}

export interface ClassifyContext {
  /** Hostname from the provider's baseUrl — used to distinguish custom vs well-known hosts on ENOTFOUND. */
  configuredHost?: string;
  /** Human-readable name of the provider (e.g. 'LM Studio', 'Anthropic'). */
  providerName?: string;
  /** Model identifier configured for this provider. */
  modelName?: string;
  /** Base URL of the provider (e.g. 'http://localhost:1234'). */
  baseUrl?: string;
}

/** Well-known API hostnames whose ENOTFOUND errors indicate a transient DNS issue, not misconfiguration. */
const WELL_KNOWN_API_HOSTS = ['api.anthropic.com', 'api.openai.com'];

/** HTTP status substrings that indicate the connection was refused or auth failed (config). */
const CONFIG_STATUS_PATTERNS = [' 401 ', ' 403 '];

/** HTTP status substrings that indicate a transient server-side issue. */
const TRANSIENT_STATUS_PATTERNS = [' 429 ', ' 500 ', ' 503 '];

/** Message substrings that indicate a missing/unloaded model (config). */
const MODEL_NOT_FOUND_PATTERNS = [
  'model not found',
  'model not loaded',
  'no model loaded',
];

/** Message substrings that indicate a resource/load failure (config). */
const RESOURCE_FAILURE_PATTERNS = [
  'model_load_failed',
  'insufficient system resources',
  'unsupported',
  'not compatible',
];

/** Message substrings that indicate a transient network issue. */
const TRANSIENT_MESSAGE_PATTERNS = [
  'socket hang up',
];

/** Node.js error codes that map to config errors. */
const CONFIG_ERROR_CODES = new Set(['ECONNREFUSED']);

/** Node.js error codes that map to transient errors. */
const TRANSIENT_ERROR_CODES = new Set(['ETIMEDOUT', 'ECONNRESET']);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasCode(err: Error, code: string): boolean {
  return (err as NodeJS.ErrnoException).code === code;
}

function hasAnyCode(err: Error, codes: Set<string>): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code !== undefined && codes.has(code);
}

function messageContains(err: Error, patterns: string[]): boolean {
  const msg = err.message.toLowerCase();
  return patterns.some((p) => msg.includes(p.toLowerCase()));
}

function statusMatch(err: Error, patterns: string[]): boolean {
  // Match patterns with leading/trailing space to avoid false positives in
  // long numeric strings. Also handle end-of-string (e.g. "failed: 401").
  const msg = ' ' + err.message + ' ';
  return patterns.some((p) => msg.includes(p));
}

// ---------------------------------------------------------------------------
// Suggested action builders
// ---------------------------------------------------------------------------

function connectionRefusedAction(ctx: ClassifyContext): string {
  const provider = ctx.providerName ?? 'the provider';
  const url = ctx.baseUrl ? ` at ${ctx.baseUrl}` : '';
  return `${provider} is not reachable${url}. Check that ${provider} is running and the baseUrl is correct.`;
}

function modelNotFoundAction(ctx: ClassifyContext): string {
  const model = ctx.modelName ? `'${ctx.modelName}'` : 'the configured model';
  const provider = ctx.providerName ?? 'the provider';
  return `Model ${model} was not found in ${provider}. Ensure the model is downloaded and loaded.`;
}

function resourceExhaustionAction(ctx: ClassifyContext): string {
  const provider = ctx.providerName ?? 'the provider';
  return `${provider} could not load the model due to insufficient resources. Try a smaller model or free up memory.`;
}

function authFailureAction(status: '401' | '403', ctx: ClassifyContext): string {
  const provider = ctx.providerName ?? 'the provider';
  if (status === '401') {
    return `Authentication failed for ${provider}. Check that the API key is set and valid.`;
  }
  return `Access denied (403) for ${provider}. Check API key permissions and account status.`;
}

function dnsFailureAction(ctx: ClassifyContext): string {
  const provider = ctx.providerName ?? 'the provider';
  const host = ctx.configuredHost ?? 'the configured host';
  return `Cannot resolve host '${host}' for ${provider}. Check the baseUrl hostname.`;
}

// ---------------------------------------------------------------------------
// Main classifier
// ---------------------------------------------------------------------------

export function classifyError(error: Error, context?: ClassifyContext): ClassifyResult {
  const ctx = context ?? {};

  // 1. Parse errors — structural/LLM output issues
  if (error instanceof SyntaxError) {
    return { type: 'parse', suggestedAction: 'LLM returned unparseable JSON. The response may be malformed or truncated.' };
  }
  if (error.name === 'ParseError') {
    return { type: 'parse', suggestedAction: 'LLM returned an empty or invalid response. Check model health and prompt.' };
  }
  const msgLower = error.message.toLowerCase();
  if (msgLower.includes('empty content') || msgLower.includes('schema validation')) {
    return { type: 'parse', suggestedAction: 'LLM returned an empty or schema-invalid response. Check model health and prompt.' };
  }

  // 2. Config errors — connection refused
  if (hasCode(error, 'ECONNREFUSED') || hasAnyCode(error, CONFIG_ERROR_CODES)) {
    return { type: 'config', suggestedAction: connectionRefusedAction(ctx) };
  }

  // 3. Config errors — model not found / not loaded
  if (messageContains(error, MODEL_NOT_FOUND_PATTERNS)) {
    return { type: 'config', suggestedAction: modelNotFoundAction(ctx) };
  }

  // 4. Config errors — resource exhaustion / load failure
  if (messageContains(error, RESOURCE_FAILURE_PATTERNS)) {
    return { type: 'config', suggestedAction: resourceExhaustionAction(ctx) };
  }

  // 5. Config errors — auth failures (401, 403)
  if (statusMatch(error, [' 401 '])) {
    return { type: 'config', suggestedAction: authFailureAction('401', ctx) };
  }
  if (statusMatch(error, [' 403 '])) {
    return { type: 'config', suggestedAction: authFailureAction('403', ctx) };
  }
  // Also handle message ending with status code (e.g. "failed: 401")
  if (/ 401$/.test(error.message) || error.message.endsWith(' 401')) {
    return { type: 'config', suggestedAction: authFailureAction('401', ctx) };
  }
  if (/ 403$/.test(error.message) || error.message.endsWith(' 403')) {
    return { type: 'config', suggestedAction: authFailureAction('403', ctx) };
  }

  // 6. ENOTFOUND — distinguish config vs transient by hostname
  if (hasCode(error, 'ENOTFOUND')) {
    // If a configuredHost was provided and appears in the message, it's misconfiguration
    if (ctx.configuredHost && error.message.includes(ctx.configuredHost)) {
      return { type: 'config', suggestedAction: dnsFailureAction(ctx) };
    }
    // If the message contains a well-known API host, treat as transient DNS blip
    if (WELL_KNOWN_API_HOSTS.some((host) => error.message.includes(host))) {
      return { type: 'transient' };
    }
    // Unknown host with no configuredHost context — treat as config
    return { type: 'config', suggestedAction: dnsFailureAction(ctx) };
  }

  // 7. Transient errors — AbortError / timeout
  if (error.name === 'AbortError') {
    return { type: 'transient' };
  }
  if (hasAnyCode(error, TRANSIENT_ERROR_CODES)) {
    return { type: 'transient' };
  }

  // 8. Transient errors — rate limit / server error status codes
  if (statusMatch(error, TRANSIENT_STATUS_PATTERNS)) {
    return { type: 'transient' };
  }

  // 9. Transient errors — message patterns
  if (messageContains(error, TRANSIENT_MESSAGE_PATTERNS)) {
    return { type: 'transient' };
  }

  // 10. Default: transient (unknown errors are assumed recoverable)
  return { type: 'transient' };
}
