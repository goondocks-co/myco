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
import type { ProviderConfig, RuntimeUsage } from '@myco/agent/types.js';
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
import { createInstrumentedFetch } from '@myco/utils/instrumented-fetch.js';

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
 * Outbound LLM fetch instrumentation for the OpenAI Agents harness.
 *
 * Owns the cross-provider protection that's missing from the SDK out of
 * the box: bounded response-headers timeout, no-progress watchdog (any
 * stream that drops below the idle threshold gets aborted with a stable
 * `fetch.stall` log entry), and `setImmediate` yields between body chunks
 * so a high-rate streamed response never starves libuv timers or the
 * daemon's HTTP listener. See `utils/instrumented-fetch.ts` for the full
 * contract.
 *
 * Defaults are chosen for local-provider tolerance — LMStudio / Ollama
 * on cold first-byte and big context loads can take a while — but still
 * tight enough that a wedged stream dies in tens of seconds, not the
 * SDK's default 600s.
 */
const harnessFetch = createInstrumentedFetch({
  component: 'agent.openai-harness',
  // 90s of silence allowed before headers — covers cold model warm-up on
  // a local backend at high context.
  responseHeadersTimeoutMs: 90_000,
  // 45s between body chunks before we treat the stream as wedged. A
  // healthy local model emits chunks well under a second apart even when
  // it's reasoning; 45s is several orders of magnitude above that.
  idleTimeoutMs: 45_000,
});

function createProvider(provider: ProviderConfig | undefined): OpenAIProvider {
  const { apiKey, baseURL } = resolveOpenAIClientConfig(provider);
  const client = new OpenAI({
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    fetch: harnessFetch,
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
  const modelSettings = gpt5ReasoningSettingsRequired(preparedExecution.model)
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
    modelProvider: testOverrides.modelProvider ?? createProvider(preparedExecution.provider),
  });
  return { agent, runner, mcpServer };
}

/**
 * Try to pull `rawResponses` (the accumulated LLM round-trips) off a
 * thrown SDK error so the caller still gets usage telemetry on failure.
 * The shape varies across SDK versions and error types — we check the
 * common ones and return undefined if none match.
 */
function extractPartialRawResponses(err: unknown): Array<Parameters<typeof toOpenAIUsage>[0][number]> | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const candidates: unknown[] = [
    (err as { rawResponses?: unknown }).rawResponses,
    (err as { state?: { rawResponses?: unknown } }).state?.rawResponses,
    (err as { result?: { rawResponses?: unknown } }).result?.rawResponses,
  ];
  for (const c of candidates) {
    if (Array.isArray(c)) return c as Array<Parameters<typeof toOpenAIUsage>[0][number]>;
  }
  return undefined;
}
