import crypto from 'node:crypto';
import OpenAI from 'openai';
import {
  Agent,
  Runner,
  OpenAIProvider,
  gpt5ReasoningSettingsRequired,
  type AgentInputItem,
  type JsonSchemaDefinition,
  type ModelProvider,
  type Session,
} from '@openai/agents';
import {
  HarnessExecutionError,
  type AgentHarness,
  type HarnessCapability,
  type HarnessErrorKind,
  type HarnessExecuteInput,
  type HarnessExecuteResult,
  type HarnessScope,
  type HarnessScopeRunInput,
  type HarnessScopeSetup,
} from './types.js';
import { isConnectionError, isCapHitMessage } from './classify-error.js';
import { createLocalVaultMcpServer } from './openai-local-mcp.js';
import type { ProviderConfig, RunLogger, RuntimeUsage } from '@myco/agent/types.js';
import { HARNESS_OPENAI_AGENTS } from '@myco/agent/types.js';
import { DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS } from '@myco/agent/context-windows.js';
import { ensureOllamaContextVariant } from '@myco/agent/ollama-context.js';
import { OPENAI_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from '@myco/providers/env.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio.js';
import {
  getLocalOpenAIBackendDefaultBaseUrl,
  inferLocalOpenAIBackendKind,
  tryParseUrl,
  type LocalOpenAIBackendKind,
} from '@myco/intelligence/local-openai-backends.js';
import { DEFAULT_OPENAI_URL, DEFAULT_OPENROUTER_URL } from '@myco/agent/provider.js';
import { resolveModelSettings } from '@myco/agent/reasoning-levels.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { createInstrumentedFetch, type FetchLike, type InstrumentedFetchLogger } from '@myco/utils/instrumented-fetch.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';

export function classifyHarnessErrorKind(message: string, errName: string | undefined): HarnessErrorKind {
  if (isConnectionError(message)) return 'connection';
  if (errName === 'MaxTurnsExceededError' || isCapHitMessage(message)) return 'max-turns';
  return 'other';
}

const OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY = 'myco-local-openai-compatible';
const OPENAI_API_PATH = '/v1';
const SESSION_RESUME_ERROR_PATTERNS = [
  /session/i,
  /resume/i,
  /previous[_ ]response/i,
  /conversation/i,
];

class PersistedSession implements Session {
  private items: AgentInputItem[];
  private readonly persist: (items: AgentInputItem[]) => void;
  private readonly sessionId: string;

  constructor(sessionId: string, items: AgentInputItem[] | undefined, persist: (items: AgentInputItem[]) => void) {
    this.sessionId = sessionId;
    this.items = items ? [...items] : [];
    this.persist = persist;
  }

  async getSessionId(): Promise<string> {
    return this.sessionId;
  }

  async getItems(): Promise<AgentInputItem[]> {
    return [...this.items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.items.push(...items);
    this.persist(this.items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    const item = this.items.pop();
    this.persist(this.items);
    return item;
  }

  async clearSession(): Promise<void> {
    this.items = [];
    this.persist(this.items);
  }
}

// Local OpenAI-compatible providers (Ollama, LM Studio, llama.cpp) commonly
// omit the *Details arrays entirely. Mark them optional so the compiler
// enforces the `?? []` guard at every call site.
function toOpenAIUsage(rawResponses: Array<{
  usage: {
    requests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    inputTokensDetails?: Array<Record<string, number>>;
    outputTokensDetails?: Array<Record<string, number>>;
  };
}>): RuntimeUsage {
  const usage = rawResponses.reduce(
    (acc, response) => {
      acc.requests += response.usage.requests;
      acc.inputTokens += response.usage.inputTokens;
      acc.outputTokens += response.usage.outputTokens;
      acc.totalTokens += response.usage.totalTokens;
      acc.reasoningTokens += (response.usage.outputTokensDetails ?? []).reduce((sum, detail) => sum + (detail.reasoning_tokens ?? 0), 0);
      acc.cachedTokens += (response.usage.inputTokensDetails ?? []).reduce((sum, detail) => sum + (detail.cached_tokens ?? 0), 0);
      return acc;
    },
    { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, reasoningTokens: 0, cachedTokens: 0 },
  );

  return {
    ...usage,
    requestUsageEntries: rawResponses.map((response) => ({
      ...response.usage,
    })),
  };
}

type OpenAIClientConfig = {
  apiKey?: string;
  baseURL?: string;
};

const PLACEHOLDER = OPENAI_COMPATIBLE_PLACEHOLDER_API_KEY;

const PROVIDER_CLIENT_CONFIG_RESOLVERS: Record<ProviderConfig['type'], (provider?: ProviderConfig) => OpenAIClientConfig> = {
  anthropic: () => ({
    apiKey: process.env.OPENAI_API_KEY ?? PLACEHOLDER,
  }),
  ollama: (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('ollama')),
  }),
  lmstudio: (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    baseURL: provider?.baseUrl ?? toOpenAIBaseUrl(getLocalOpenAIBackendDefaultBaseUrl('lmstudio')),
  }),
  // Remote providers: the API key must come from the daemon's env (loaded
  // from .myco/secrets.env), never from a ProviderConfig. The baseURL is
  // locked to the hardcoded default so the bearer key cannot follow a
  // caller-supplied redirect.
  openai: () => ({
    apiKey: process.env[OPENAI_API_KEY_ENV] ?? process.env.OPENAI_API_KEY,
    baseURL: DEFAULT_OPENAI_URL,
  }),
  openrouter: () => ({
    apiKey: process.env[OPENROUTER_API_KEY_ENV],
    baseURL: DEFAULT_OPENROUTER_URL,
  }),
  'openai-compatible': (provider) => ({
    apiKey: provider?.apiKey ?? PLACEHOLDER,
    ...(provider?.baseUrl ? { baseURL: provider.baseUrl } : {}),
  }),
};

export function resolveOpenAIClientConfig(provider?: ProviderConfig): OpenAIClientConfig {
  const normalizedProvider = normalizeProviderForOpenAIClient(provider);
  const type = normalizedProvider?.type ?? 'openai';
  return PROVIDER_CLIENT_CONFIG_RESOLVERS[type](normalizedProvider);
}

export function shouldUseResponsesApi(provider?: ProviderConfig): boolean {
  return provider?.type !== 'openai-compatible'
    && provider?.type !== 'ollama'
    && provider?.type !== 'lmstudio';
}

function toOpenAIBaseUrl(baseUrl: string): string {
  const url = tryParseUrl(baseUrl);
  if (!url) return baseUrl;
  if (url.pathname === OPENAI_API_PATH || url.pathname.startsWith(`${OPENAI_API_PATH}/`)) {
    return url.toString().replace(/\/$/, '');
  }
  url.pathname = `${url.pathname.replace(/\/$/, '')}${OPENAI_API_PATH}`;
  return url.toString().replace(/\/$/, '');
}

function toLocalControlBaseUrl(baseUrl: string): string {
  const url = tryParseUrl(baseUrl);
  if (!url) return baseUrl;
  if (url.pathname === OPENAI_API_PATH) {
    url.pathname = '/';
  } else if (url.pathname.startsWith(`${OPENAI_API_PATH}/`)) {
    url.pathname = url.pathname.slice(OPENAI_API_PATH.length) || '/';
  }
  return url.toString().replace(/\/$/, '');
}

function resolveLocalContextLength(provider?: ProviderConfig): number {
  return provider?.contextLength ?? DEFAULT_LOCAL_AGENT_CONTEXT_WINDOW_TOKENS;
}

function normalizeProviderForOpenAIClient(provider?: ProviderConfig): ProviderConfig | undefined {
  if (!provider) return provider;
  const localBackend = inferLocalOpenAIBackendKind({
    type: provider.type,
    localBackend: provider.localBackend,
    baseUrl: provider.baseUrl,
  });
  if (!localBackend) {
    return provider;
  }
  const baseUrl = provider.baseUrl ?? getLocalOpenAIBackendDefaultBaseUrl(localBackend);
  return {
    ...provider,
    baseUrl: toOpenAIBaseUrl(baseUrl),
  };
}

async function prepareLocalProviderExecution(
  provider: ProviderConfig | undefined,
  model: string,
): Promise<{ provider: ProviderConfig | undefined; model: string }> {
  const normalizedProvider = normalizeProviderForOpenAIClient(provider);
  if (!normalizedProvider) {
    return { provider: normalizedProvider, model };
  }
  const localBackend = inferLocalOpenAIBackendKind({
    type: normalizedProvider.type,
    localBackend: normalizedProvider.localBackend,
    baseUrl: normalizedProvider.baseUrl,
  });
  if (!localBackend) {
    return { provider: normalizedProvider, model };
  }

  const contextLength = resolveLocalContextLength(normalizedProvider);
  if (localBackend === 'ollama') {
    const variantModel = await ensureOllamaContextVariant(model, contextLength);
    return {
      provider: {
        ...normalizedProvider,
        contextLength,
      },
      model: variantModel,
    };
  }

  const controlBaseUrl = toLocalControlBaseUrl(
    normalizedProvider.baseUrl ?? getLocalOpenAIBackendDefaultBaseUrl('lmstudio'),
  );
  const backend = new LmStudioBackend({
    base_url: controlBaseUrl,
    model,
    context_window: contextLength,
  });
  await backend.ensureLoaded(contextLength, false);
  return {
    provider: {
      ...normalizedProvider,
      contextLength,
    },
    model: backend.getLoadedInstanceId() ?? model,
  };
}

/**
 * A Responses-API response body shaped closely enough to check the fields
 * the SDK ignores. OpenRouter's `/api/v1/responses` uses this exact shape
 * for both success and upstream-provider-failure bodies — the only thing
 * that changes is `status`/`error`/`output`. Left loose (all fields
 * optional, `unknown` output items) because we only ever read three fields
 * and must never throw while inspecting an otherwise-valid body from a
 * spec-compliant provider.
 */
interface ResponsesBodyShape {
  status?: string;
  error?: { message?: string; code?: string; [key: string]: unknown } | null;
  output?: Array<{ type?: string; [key: string]: unknown }> | null;
  id?: string;
  [key: string]: unknown;
}

/**
 * True when a parsed Responses-API body represents an upstream provider
 * failure OpenAI's own SDK would never surface as an error on its own:
 *   - `status: "failed"` with an `error` payload — the terminal failure
 *     shape spore discovery-5c27c512 verified live against OpenRouter.
 *   - `status: "incomplete"` where every output item is a `reasoning` item
 *     (or there are none at all) — the model was cut off before producing
 *     any real content, which agents-core's turn loop treats identically
 *     to a fully empty turn ("if there is no output we just run again").
 * `status: "completed"` (or any other status) with a non-empty non-
 * reasoning output always passes through untouched.
 */
export function isUnsurfacedResponsesFailure(body: ResponsesBodyShape): boolean {
  if (body.status === 'failed') {
    return true;
  }
  if (body.status === 'incomplete') {
    const output = Array.isArray(body.output) ? body.output : [];
    const hasSubstantiveOutput = output.some((item) => item?.type !== 'reasoning');
    return !hasSubstantiveOutput;
  }
  return false;
}

function describeResponsesFailure(body: ResponsesBodyShape): string {
  const detail = body.error?.message ?? (body.status === 'incomplete'
    ? 'incomplete response with no non-reasoning output'
    : 'no error detail provided');
  const generationId = body.id ? ` (response id: ${body.id})` : '';
  return `OpenRouter upstream provider failure: ${detail}${generationId}`;
}

/**
 * Wrap an already-instrumented fetch with Responses-API body validation —
 * the fix for spore discovery-5c27c512: OpenRouter's `/api/v1/responses`
 * returns HTTP 200 for an upstream provider failure (`status: "failed"`,
 * `error: {...}`, `output: []`, `usage: null`; also `status: "incomplete"`
 * with reasoning-only output). `@openai/agents` v0.12.0's
 * `OpenAIResponsesModel.getResponse` reads only `response.output` and
 * `response.usage` — it never checks `status`/`error` — so a 200-wrapped
 * failure becomes a zero-item model turn, and agents-core's turn loop
 * silently re-runs ("if there is no output we just run again") until
 * `MaxTurnsExceededError`, burning the whole turn budget in seconds with
 * zero tool events and zero recorded usage.
 *
 * Interception point: `@openai/agents`'s `Runner.run()` (called by
 * `runOpenAIAgent` below) never passes `stream: true` — `getResponse`
 * (non-streaming) is the only path this harness exercises, and it calls
 * `this._client.responses.create(requestData, requestOptions)` with
 * `requestData.stream` unset/false, which the OpenAI SDK turns into
 * `POST /responses` with `stream: false` (openai/resources/responses/
 * responses.js). That single non-streaming POST response is exactly what
 * this wrapper inspects. Streaming responses (SSE body, incremental
 * `response.output_text.delta` events) are NOT inspected here — this
 * harness's own call path never produces one, so there is no streaming
 * residual to cover. If a future caller starts passing `stream: true`,
 * this wrapper passes those responses through untouched (the streaming
 * check below only matches non-streaming POST requests) and the original
 * silent-loop failure mode would return uncovered for that path.
 *
 * Applies to any POST whose URL path ends in `/responses` — not just
 * OpenRouter — since the same SDK gap exists for any Responses-API-shaped
 * provider that returns this 200-wrapped-failure shape.
 *
 * On a clean body (anything that doesn't match
 * `isUnsurfacedResponsesFailure`), the original `Response` is returned
 * byte-identical: same status/headers/body stream, no re-serialization.
 */
export function wrapResponsesFailureDetection(baseFetch: FetchLike, logger?: InstrumentedFetchLogger): FetchLike {
  return async function harnessValidatingFetch(input, init) {
    const response = await baseFetch(input, init);

    const method = (init?.method
      ?? (typeof input === 'object' && input !== null && 'method' in (input as Request) ? (input as Request).method : 'GET')
      ?? 'GET').toUpperCase();
    if (method !== 'POST' || !response.ok || !response.body) {
      return response;
    }
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url;
    let pathname: string;
    try {
      pathname = new URL(url, 'http://localhost').pathname;
    } catch {
      return response;
    }
    if (!pathname.endsWith('/responses')) {
      return response;
    }
    // A streamed request (`stream: true` in the POST body) yields an SSE
    // body, not a single JSON object — `.json()` would hang waiting for the
    // stream to close or throw on the first `data: {...}` chunk. This
    // harness never sends `stream: true` (see the doc comment above), so
    // this branch protects against a future caller silently losing
    // coverage rather than crashing on a shape this wrapper can't parse.
    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('text/event-stream')) {
      return response;
    }

    const cloned = response.clone();
    let body: ResponsesBodyShape;
    try {
      body = await cloned.json();
    } catch {
      // Not JSON (or malformed) — not our shape to police. Let the OpenAI
      // SDK's own body handling see the original, still-unread response.
      return response;
    }

    if (!isUnsurfacedResponsesFailure(body)) {
      return response;
    }

    const message = describeResponsesFailure(body);
    logger?.warn?.(LOG_KINDS.FETCH_PROVIDER_FAILURE, `agent.openai-harness: ${message}`, {
      component: 'agent.openai-harness',
      url: redactQuery(url),
      status: body.status,
      responseId: body.id,
      errorCode: body.error?.code,
    });

    // Synthesize a 5xx so the OpenAI SDK's own response handling
    // (client.js) parses the body as an API error and throws `APIError`/
    // `InternalServerError` — the same code path a genuine HTTP 5xx takes,
    // including the SDK's own retry-on-5xx behavior. This keeps the error
    // surfacing through the SDK's normal machinery instead of throwing
    // out-of-band from inside a `fetch` implementation, which callers of
    // `fetch` don't expect and the SDK isn't set up to catch cleanly.
    return new Response(JSON.stringify({ error: { message, code: body.error?.code ?? 'provider_unavailable' } }), {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'content-type': 'application/json' },
    });
  };
}

/** Strip query params before logging — provider URLs can carry tokens. */
function redactQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.href;
  } catch {
    return url.split('?')[0] ?? url;
  }
}

/**
 * Build the outbound LLM fetch for the OpenAI Agents harness: instrumented
 * (bounded response-headers timeout, no-progress watchdog, per-chunk
 * event-loop yields — see `utils/instrumented-fetch.ts`) and wrapped with
 * Responses-API failure detection (`wrapResponsesFailureDetection` above).
 *
 * Called once per `createProvider` invocation (i.e. once per harness
 * execute/openScope call) so the run's own logger flows into both layers —
 * `agent.openai-harness` debug/warn log lines are otherwise permanently
 * silent, since the run logger is the only logger threaded through
 * `HarnessExecuteInput`/`HarnessScopeSetup` (there is no ambient daemon
 * logger reachable from this module).
 *
 * Defaults are chosen for local-provider tolerance — LMStudio / Ollama
 * on cold first-byte and big context loads can take a while — but still
 * tight enough that a wedged stream dies in tens of seconds, not the
 * SDK's default 600s.
 */
function createHarnessFetch(logger?: RunLogger): FetchLike {
  const instrumented = createInstrumentedFetch({
    component: 'agent.openai-harness',
    logger,
    // 90s of silence allowed before headers — covers cold model warm-up on
    // a local backend at high context.
    responseHeadersTimeoutMs: 90_000,
    // 45s between body chunks before we treat the stream as wedged. A
    // healthy local model emits chunks well under a second apart even when
    // it's reasoning; 45s is several orders of magnitude above that.
    idleTimeoutMs: 45_000,
  });
  return wrapResponsesFailureDetection(instrumented, logger);
}

function createProvider(provider: ProviderConfig | undefined, logger?: RunLogger): OpenAIProvider {
  const { apiKey, baseURL } = resolveOpenAIClientConfig(provider);
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    fetch: createHarnessFetch(logger),
  });

  return new OpenAIProvider({
    openAIClient: client,
    useResponses: shouldUseResponsesApi(provider),
  });
}

/**
 * Strip `null`-valued object entries produced by OpenAI strict-mode's
 * widened-optional-field dialect.
 *
 * `toStrictJsonObjectSchema()` widens every optional property's type to
 * `[type, 'null']` so strict mode's "every key required" rule doesn't
 * change Myco's own optionality semantics — the model emits `null` for a
 * field Myco's schema author intended as absent. The `@openai/agents` SDK
 * does not strip these nulls from `finalOutput` (its own
 * `stripStrictNullsForJsonSchema` applies only to tool inputs), so without
 * this helper a caller like `applyDirectives()` in orchestrator.ts sees
 * `maxTurns: null` instead of `maxTurns: undefined` — and
 * `directive.maxTurns !== undefined` passes, letting `Math.min(null, ceiling)`
 * coerce to 0 and zero out the phase's turn budget.
 *
 * Recurses into nested objects and arrays; leaves non-object, non-null
 * values untouched.
 */
export function stripStrictNulls(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => stripStrictNulls(item));
  }
  if (value !== null && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (entryValue === null) continue;
      result[key] = stripStrictNulls(entryValue);
    }
    return result;
  }
  return value;
}

/**
 * Drive a single SDK turn-loop with a configured runner+agent. Used by
 * both `OpenAIAgentsHarness.execute` (which feeds in any prior session
 * data + sessionRef) and `scope.run` (always a fresh session). Centralized
 * here so usage accounting, partial-usage rescue on throw, and result-shape
 * construction stay in one place — without it the two call sites had
 * already drifted.
 */
async function runOpenAIAgent(
  runner: Runner,
  agent: Agent<unknown, any>,
  prompt: string,
  options: {
    maxTurns?: number;
    sessionRef: string;
    sessionData: AgentInputItem[];
    abortController?: AbortController;
    hasOutputSchema?: boolean;
  },
): Promise<HarnessExecuteResult> {
  let persistedItems: AgentInputItem[] = [...options.sessionData];
  const session = new PersistedSession(options.sessionRef, persistedItems, (items) => {
    persistedItems = [...items];
  });

  let usage: RuntimeUsage;
  let finalText: string;
  let turnsUsed: number;
  let lastResponseId: string | undefined;
  let structuredOutput: unknown;
  try {
    const result = await runner.run(agent, prompt, {
      maxTurns: options.maxTurns,
      session,
      ...(options.abortController ? { signal: options.abortController.signal } : {}),
    });
    // `result.finalOutput` is a getter that re-runs JSON.parse on every
    // access — capture it once here, inside the try, so a parse failure
    // (SyntaxError) gets wrapped as a HarnessExecutionError like any other
    // run failure instead of escaping raw from the return statement below.
    const finalOutput = result.finalOutput;
    usage = toOpenAIUsage(result.rawResponses);
    usage.providerData = { lastResponseId: result.lastResponseId };
    finalText = typeof finalOutput === 'string' ? finalOutput : JSON.stringify(finalOutput ?? '');
    turnsUsed = result.rawResponses.length;
    lastResponseId = result.lastResponseId;
    structuredOutput = options.hasOutputSchema ? stripStrictNulls(finalOutput) : undefined;
  } catch (err) {
    const partialRaw = extractPartialRawResponses(err);
    const partialUsage = partialRaw ? toOpenAIUsage(partialRaw) : ({} as RuntimeUsage);
    const message = err instanceof Error ? err.message : String(err);
    // The OpenAI Agents SDK throws MaxTurnsExceededError when maxTurns is
    // binding; the constructor name is the most reliable signal. Fall back
    // to wording match for forward compatibility.
    const errName = err && typeof err === 'object' ? (err as { constructor?: { name?: string } }).constructor?.name : undefined;
    const kind = classifyHarnessErrorKind(message, errName);
    throw new HarnessExecutionError(
      message,
      { usage: partialUsage, sessionRef: options.sessionRef, sessionData: persistedItems, kind },
      { cause: err instanceof Error ? err : undefined },
    );
  }

  return {
    finalText,
    turnsUsed,
    usage,
    sessionRef: options.sessionRef,
    sessionData: persistedItems,
    rawRuntimeMetadata: { lastResponseId },
    structuredOutput,
  };
}

/**
 * Test-only override slots. The single legitimate use is injecting a stub
 * ModelProvider so tests can exercise the real Agent/Runner against canned
 * responses (see tests/agent/runtime-openai.test.ts). Production callers
 * never pass overrides — `harness/index.ts` constructs the harness with no
 * arguments.
 */
export interface OpenAIAgentsHarnessTestOverrides {
  modelProvider?: ModelProvider;
}

export class OpenAIAgentsHarness implements AgentHarness {
  readonly id = HARNESS_OPENAI_AGENTS;

  constructor(private readonly testOverrides: OpenAIAgentsHarnessTestOverrides = {}) {}

  supports(capability: HarnessCapability): boolean {
    return capability === 'supportsSessionResume'
      || capability === 'supportsMcp'
      || capability === 'structuredOutput';
  }

  classifyError(error: unknown) {
    const message = errorMessage(error);
    return SESSION_RESUME_ERROR_PATTERNS.some((pattern) => pattern.test(message))
      ? 'session-resume-failed' as const
      : 'unknown' as const;
  }

  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    const setup: HarnessScopeSetup = {
      systemPrompt: input.systemPrompt,
      model: input.model,
      provider: input.provider,
      toolSurface: input.toolSurface,
      logger: input.logger,
      reasoningLevel: input.reasoningLevel,
    };
    const prepared = await prepareOpenAIRun(setup, this.testOverrides, input.outputSchema);
    try {
      return await runOpenAIAgent(prepared.runner, prepared.agent, input.prompt, {
        maxTurns: input.maxTurns,
        sessionRef: input.sessionRef ?? crypto.randomUUID(),
        sessionData: Array.isArray(input.sessionData) ? (input.sessionData as AgentInputItem[]) : [],
        abortController: input.abortController,
        hasOutputSchema: Boolean(input.outputSchema),
      });
    } finally {
      await prepared.mcpServer.close();
    }
  }

  async openScope(setup: HarnessScopeSetup): Promise<HarnessScope> {
    const prepared = await prepareOpenAIRun(setup, this.testOverrides);
    let closed = false;
    return {
      async run(input: HarnessScopeRunInput): Promise<HarnessExecuteResult> {
        if (closed) throw new Error('OpenAIAgentsHarness: scope.run() called after close()');
        return runOpenAIAgent(prepared.runner, prepared.agent, input.prompt, {
          maxTurns: input.maxTurns,
          sessionRef: crypto.randomUUID(),
          sessionData: [],
          abortController: input.abortController,
        });
      },
      async close(): Promise<void> {
        if (closed) return;
        closed = true;
        await prepared.mcpServer.close();
      },
    };
  }
}

/**
 * Convert a Myco-authored JSON Schema (optional properties allowed) into
 * OpenAI's strict JsonObjectSchema dialect: every property listed in
 * `required`, with previously-optional properties widened to a nullable
 * union type (`[type, 'null']`) so the strict-mode contract (every key
 * required) doesn't change the schema's actual optionality semantics —
 * the model can still emit `null` for a field Myco's own code treats as
 * optional. `additionalProperties: false` is preserved at every object
 * level (already present on Myco's own schemas; asserted here rather than
 * injected, since a schema without it is a bug in the caller).
 *
 * Recurses into nested object schemas (e.g., `phases.items`) so multi-
 * level schemas like ORCHESTRATOR_PLAN_JSON_SCHEMA convert correctly.
 */
export function toStrictJsonObjectSchema(schema: Record<string, unknown>): Record<string, unknown> {
  if (schema['type'] !== 'object' || typeof schema['properties'] !== 'object' || schema['properties'] === null) {
    return schema;
  }
  const properties = schema['properties'] as Record<string, Record<string, unknown>>;
  const originalRequired = new Set(Array.isArray(schema['required']) ? (schema['required'] as string[]) : []);
  const strictProperties: Record<string, unknown> = {};

  for (const [key, propSchema] of Object.entries(properties)) {
    let converted = propSchema;
    if (propSchema['type'] === 'object') {
      converted = toStrictJsonObjectSchema(propSchema);
    } else if (propSchema['type'] === 'array' && typeof propSchema['items'] === 'object' && propSchema['items'] !== null) {
      converted = { ...propSchema, items: toStrictJsonObjectSchema(propSchema['items'] as Record<string, unknown>) };
    }
    if (!originalRequired.has(key)) {
      const baseType = converted['type'];
      if (baseType === undefined) {
        throw new Error(
          `toStrictJsonObjectSchema: optional property "${key}" has no "type" key — ` +
            'enum/anyOf/$ref-shaped schemas are not supported for strict-mode widening.',
        );
      }
      converted = { ...converted, type: [baseType, 'null'] };
    }
    strictProperties[key] = converted;
  }

  return {
    ...schema,
    properties: strictProperties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

/**
 * Strip an OpenRouter-style vendor prefix ("openai/gpt-5.4-mini" ->
 * "gpt-5.4-mini") for model-family classification only. OpenRouter slugs
 * are `<vendor>/<model>`; everything through the first '/' is the vendor.
 * A slug with no '/' (a bare OpenAI model name, or a non-vendor-prefixed
 * route) is returned unchanged.
 */
function stripVendorPrefix(model: string): string {
  const slashIndex = model.indexOf('/');
  return slashIndex === -1 ? model : model.slice(slashIndex + 1);
}

/**
 * Build the per-setup SDK machinery: connect the MCP server, construct
 * the Agent + Runner pair. Both `execute` (single-shot, runs once and
 * closes) and `openScope` (long-lived, scope.run() called N times) share
 * this — they only diverge in resource lifetime.
 */
async function prepareOpenAIRun(
  setup: HarnessScopeSetup,
  testOverrides: OpenAIAgentsHarnessTestOverrides = {},
  outputSchema?: HarnessExecuteInput['outputSchema'],
): Promise<{
  agent: Agent<unknown, any>;
  runner: Runner;
  mcpServer: ReturnType<typeof createLocalVaultMcpServer>;
}> {
  const preparedExecution = await prepareLocalProviderExecution(setup.provider, setup.model);
  const mcpServer = createLocalVaultMcpServer(setup.toolSurface);
  await mcpServer.connect();
  // Only attach `modelSettings` for models the SDK itself recognizes as
  // GPT-5-family reasoning models (`gpt5ReasoningSettingsRequired`, exported
  // by @openai/agents-core's defaultModel.js and re-exported from
  // '@openai/agents'). The Agent constructor (agents-core/dist/agent.js
  // ~96-116) already resets `modelSettings` to `{}` for a non-GPT-5 model
  // UNLESS the caller explicitly passed `modelSettings` — so explicitly
  // attaching `reasoning.effort`/`text.verbosity` here for e.g. gpt-4.1* or
  // an arbitrary openrouter route would bypass that guard and send fields
  // the model's API rejects with a 400. Omitting the key entirely for a
  // non-reasoning-capable model preserves the SDK's own pre-branch default.
  //
  // `gpt5ReasoningSettingsRequired` does a plain `startsWith('gpt-5')` check,
  // which fails on OpenRouter's vendor-prefixed slugs (e.g.
  // "openai/gpt-5.4-mini") — the check must see the unprefixed model name.
  // Strip the vendor prefix ONLY for this classification; the actual request
  // still sends `preparedExecution.model` (the full slug) unchanged.
  const modelSettings = gpt5ReasoningSettingsRequired(stripVendorPrefix(preparedExecution.model))
    ? resolveModelSettings(setup.reasoningLevel, setup.provider)
    : undefined;
  const agent = new Agent({
    name: 'myco-agent',
    instructions: setup.systemPrompt ?? 'You are the Myco agent harness.',
    model: preparedExecution.model,
    mcpServers: [mcpServer],
    ...(modelSettings ? { modelSettings } : {}),
    ...(outputSchema ? {
      outputType: {
        type: 'json_schema',
        name: outputSchema.name,
        strict: true,
        schema: toStrictJsonObjectSchema(outputSchema.schema),
      } as JsonSchemaDefinition,
    } : {}),
  });
  const runner = new Runner({
    modelProvider: testOverrides.modelProvider ?? createProvider(preparedExecution.provider, setup.logger),
  });
  return { agent, runner, mcpServer };
}

/**
 * Try to pull `rawResponses` (the accumulated LLM round-trips) off a
 * thrown SDK error so the caller still gets usage telemetry on failure.
 * The shape varies across SDK versions and error types — we check the
 * common ones and return undefined if none match.
 *
 * `AgentsError` (the base class of e.g. `MaxTurnsExceededError`) carries a
 * bare `RunState` on `.state`, not a `RunResult` — `RunResult.rawResponses`
 * is a getter that reads `this.state._modelResponses` (agents-core
 * result.js), but `RunState` itself exposes only `_modelResponses` directly,
 * with no `rawResponses` getter of its own. Without this candidate, every
 * MaxTurnsExceededError rescue silently returned {} usage even though the
 * SDK had already accumulated real, billed turns on `state._modelResponses`.
 */
function extractPartialRawResponses(err: unknown): Array<Parameters<typeof toOpenAIUsage>[0][number]> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const candidates: unknown[] = [
    (err as { rawResponses?: unknown }).rawResponses,
    (err as { state?: { rawResponses?: unknown } }).state?.rawResponses,
    (err as { state?: { _modelResponses?: unknown } }).state?._modelResponses,
    (err as { result?: { rawResponses?: unknown } }).result?.rawResponses,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Array<Parameters<typeof toOpenAIUsage>[0][number]>;
  }
  return undefined;
}
