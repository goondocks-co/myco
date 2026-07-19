import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type {
  HarnessExecuteInput,
  HarnessExecuteResult,
  AgentHarness,
  HarnessCapability,
  HarnessScope,
  HarnessScopeRunInput,
  HarnessScopeSetup,
} from './types.js';
import { HarnessExecutionError, type HarnessErrorKind } from './types.js';
import { isConnectionError } from './classify-error.js';
import { HARNESS_CLAUDE_SDK } from '@myco/agent/types.js';
import {
  createMaterializedVaultToolServer,
  createScopedVaultToolServer,
  createVaultToolServer,
} from '@myco/agent/tools.js';
import { buildPhaseEnv, isLocalProvider } from '@myco/agent/provider.js';
import { resolveThinkingConfig } from '@myco/agent/reasoning-levels.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { resolveClaudeCodeExecutable } from './claude-code-executable.js';

const MCP_SERVER_NAME = 'myco-vault';

const SESSION_RESUME_ERROR_PATTERNS = [
  /session/i,
  /resume/i,
  /previous[_ ]response/i,
  /conversation/i,
];

const EXPIRED_SESSION_ERROR_PATTERNS = [
  /exited with code/i,
  /session[\s_-]*not[\s_-]*found/i,
  /session[\s_-]*expired/i,
  /session[\s_-]*(is|was)?[\s_-]*(gone|missing|invalid)/i,
];

/**
 * Per-process isolated plugin cache directory for agent runs. The Claude
 * SDK reads `~/.claude/plugins/installed_plugins.json` by default, which
 * pulls in every plugin the user has installed in their developer Claude
 * Code — dozens of extra tools we didn't register, some with schemas
 * Anthropic's API now rejects (top-level `oneOf`/`allOf`/`anyOf`). Setting
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` to an empty directory gives the agent a
 * clean, deterministic tool surface: only our MCP vault tools.
 *
 * Empty isn't enough, though: when the SDK boots against an empty cache
 * dir it *populates* it from the user's global
 * `~/.claude/plugins/installed_plugins.json` on first use, re-introducing
 * every plugin we meant to exclude. Pre-seeding the dir with an explicit
 * empty manifest short-circuits that sync — the SDK sees a valid-but-
 * empty plugins list and loads none.
 *
 * Created once per daemon process and reused across runs.
 */
let isolatedPluginCacheDir: string | undefined;

function getIsolatedPluginCacheDir(): string {
  if (isolatedPluginCacheDir) return isolatedPluginCacheDir;
  const dir = path.join(os.tmpdir(), `myco-agent-plugin-cache-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  const manifestPath = path.join(dir, 'installed_plugins.json');
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(
      manifestPath,
      JSON.stringify({ version: 2, plugins: {} }),
    );
  }
  isolatedPluginCacheDir = dir;
  return dir;
}

/**
 * Drain a Claude SDK message stream into a final text + usage tally,
 * capturing the provider-validated `structured_output` (when the caller
 * requested one via `outputFormat` and the terminal `result` message
 * carries it) alongside the plain-text result.
 *
 * Both `execute` and `openScope.run` produce identical message-stream
 * shapes — only their `query()` options differ (resume + persistSession in
 * `execute`, fresh + ephemeral in `openScope`). Centralizing the loop
 * keeps usage accounting, partial-usage rescue on stream errors, and the
 * assistant-message turn fallback consistent across both paths; without it
 * the two had already drifted (e.g., `assistantMessages` rescue was added
 * to one and not the other).
 */
/** Raw usage shape shared by both the per-message `BetaUsage` and the run-level result usage. */
interface RawAnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Fold a raw Anthropic usage snapshot into the composition the rest of
 * Myco's cost/budget pipeline expects.
 *
 * The Anthropic SDK's `input_tokens` counts only tokens billed at the full
 * uncached rate — cache writes and cache reads are reported separately and
 * excluded from it. Fold both into `inputTokens` so it represents the true
 * total prompt size (what cost/breakdown.ts's `uncachedInputTokens =
 * inputTokens - cachedTokens` subtraction expects), and surface
 * `cachedTokens` as just the cache-read count — the portion that did NOT
 * pay the uncached rate. Cache-creation tokens stay folded into
 * `inputTokens` only, since they bill at their own (higher, but still not
 * "uncached") rate rather than the cached-read rate.
 *
 * Read defensively: the declared SDK type is non-null, but a future SDK
 * revision or an error-subtype result could omit these fields.
 */
function foldUsageComposition(rawUsage: RawAnthropicUsage | undefined): {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
} {
  const cacheCreationTokens = rawUsage?.cache_creation_input_tokens ?? 0;
  const cacheReadTokens = rawUsage?.cache_read_input_tokens ?? 0;
  const inputTokens = (rawUsage?.input_tokens ?? 0) + cacheCreationTokens + cacheReadTokens;
  const outputTokens = rawUsage?.output_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cachedTokens: cacheReadTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/** Exported for unit testing usage-entry composition against synthetic SDK message streams. */
export async function consumeClaudeMessageStream(
  messageStream: AsyncIterable<SDKMessage>,
  options: { localProvider: boolean; sessionRef?: string },
): Promise<{ finalText: string; turnsUsed: number; usage: HarnessExecuteResult['usage']; structuredOutput?: unknown }> {
  let finalText = '';
  let turnsUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedTokens = 0;
  let costUsd = 0;
  let assistantMessages = 0;
  let structuredOutput: unknown;
  // Per-request usage entries, one per `assistant` message — each carries
  // the SDK's own `BetaMessage.usage`, a genuine per-request snapshot (not
  // a running total). Populated as messages arrive; only falls back to a
  // single run-cumulative entry (see `buildUsage` below) if the stream
  // produced turns/tokens but no assistant message exposed usage — a
  // defensive path for SDK message shapes that don't carry per-message
  // usage, so budget analysis still has something to peak over.
  const requestUsageEntries: Array<{ inputTokens: number; outputTokens: number; cachedTokens: number; totalTokens: number }> = [];

  const buildUsage = () => ({
    requests: turnsUsed,
    inputTokens,
    outputTokens,
    cachedTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    requestUsageEntries: requestUsageEntries.length > 0
      ? requestUsageEntries
      : turnsUsed > 0
        ? [{ inputTokens, outputTokens, cachedTokens, totalTokens: inputTokens + outputTokens }]
        : [],
  });

  try {
    for await (const message of messageStream) {
      if (message.type === 'assistant') {
        assistantMessages += 1;
        // `message.message` is the raw Anthropic `BetaMessage` for this
        // turn — its `usage` is a per-request snapshot (input/output/cache
        // tokens for THIS API call only), unlike the terminal `result`
        // message's `usage`, which is the run-cumulative total. Compose it
        // the same way the run totals are composed below so
        // SUM(requestUsageEntries) tracks the run total and peak-over-
        // entries reflects a real single-request peak instead of the
        // cumulative sum every turn re-reads via prompt caching.
        const rawMessageUsage = (message.message as { usage?: RawAnthropicUsage } | undefined)?.usage;
        if (rawMessageUsage) {
          requestUsageEntries.push(foldUsageComposition(rawMessageUsage));
        }
        // Yield to libuv so the daemon's HTTP listener and lag probe
        // don't starve during high-message-count runs.
        await new Promise<void>((resolve) => setImmediate(resolve));
        continue;
      }
      if (message.type === 'result') {
        // Capture usage on any subtype — error variants still burn tokens.
        // finalText only exists on a successful result. This is the
        // run-cumulative total across every turn — the source of truth for
        // run totals/cost, left unchanged; per-request granularity comes
        // from `requestUsageEntries` above instead.
        turnsUsed = message.num_turns ?? assistantMessages;
        const rawUsage = message.usage as RawAnthropicUsage | undefined;
        const composed = foldUsageComposition(rawUsage);
        inputTokens = composed.inputTokens;
        outputTokens = composed.outputTokens;
        cachedTokens = composed.cachedTokens;
        costUsd = options.localProvider ? 0 : (message.total_cost_usd ?? 0);
        if (message.subtype === 'success') {
          finalText = message.result;
          structuredOutput = message.structured_output;
        }
      }
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (err) {
    if (turnsUsed > 0 || inputTokens > 0 || outputTokens > 0) {
      const message = errorMessage(err);
      // The Claude SDK throws with the literal message
      // "Reached maximum number of turns (N)" when maxTurns is binding.
      // Classify here so phase-loop doesn't have to regex the message.
      const kind: HarnessErrorKind = isConnectionError(message)
        ? 'connection'
        : /reached.*maximum number of turns|max\s*turns/i.test(message)
          ? 'max-turns'
          : 'other';
      throw new HarnessExecutionError(
        message,
        {
          usage: buildUsage(),
          ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}),
          kind,
        },
        { cause: err },
      );
    }
    throw err;
  }

  return { finalText, turnsUsed, usage: buildUsage(), structuredOutput };
}

function buildToolServer(input: { toolSurface: HarnessExecuteInput['toolSurface'] }) {
  const { toolSurface } = input;
  // Map-phase fast path: pre-materialized tool list. Bypasses both
  // createScopedVaultToolServer and createVaultToolServer rebuilds, which
  // would discard the argMap-stripped sink schema and outcome-capture
  // wrapper that map-phase needs. See the design spec under "Why this
  // shape" — materialized tools must flow through unchanged.
  if (toolSurface.tools && toolSurface.tools.length > 0) {
    return createMaterializedVaultToolServer(toolSurface.tools);
  }

  if (toolSurface.toolNames && toolSurface.toolNames.length === 0) {
    return null;
  }
  if (toolSurface.toolNames) {
    return createScopedVaultToolServer(
      toolSurface.agentId,
      toolSurface.runId,
      toolSurface.toolNames,
      {
        turnOffset: toolSurface.turnOffset,
        projectRoot: toolSurface.projectRoot,
        vaultDir: toolSurface.vaultDir,
        requestContext: toolSurface.requestContext,
        embeddingManager: toolSurface.embeddingManager,
        readOnly: toolSurface.readOnly,
        dryRun: toolSurface.dryRun,
        metadataAccumulator: toolSurface.metadataAccumulator,
        phasePurpose: toolSurface.phasePurpose,
        semanticCheckEnabled: toolSurface.semanticCheckEnabled,
        harnessId: toolSurface.harnessId,
        model: toolSurface.model,
        classifierReasoningLevel: toolSurface.classifierReasoningLevel,
        provider: toolSurface.provider,
        flaggedWritesAccumulator: toolSurface.flaggedWritesAccumulator,
        hooks: toolSurface.hooks,
        hookContext: toolSurface.hookContext,
        deferredNames: toolSurface.deferredNames ? new Set(toolSurface.deferredNames) : undefined,
        logger: toolSurface.logger,
      },
    );
  }

  return createVaultToolServer(toolSurface.agentId, toolSurface.runId, {
    embeddingManager: toolSurface.embeddingManager,
    projectRoot: toolSurface.projectRoot,
    vaultDir: toolSurface.vaultDir,
    requestContext: toolSurface.requestContext,
    dryRun: toolSurface.dryRun,
    metadataAccumulator: toolSurface.metadataAccumulator,
    phasePurpose: toolSurface.phasePurpose,
    semanticCheckEnabled: toolSurface.semanticCheckEnabled,
    harnessId: toolSurface.harnessId,
    model: toolSurface.model,
    classifierReasoningLevel: toolSurface.classifierReasoningLevel,
    provider: toolSurface.provider,
    flaggedWritesAccumulator: toolSurface.flaggedWritesAccumulator,
    hooks: toolSurface.hooks,
    hookContext: toolSurface.hookContext,
    deferredNames: toolSurface.deferredNames ? new Set(toolSurface.deferredNames) : undefined,
    logger: toolSurface.logger,
  });
}

export class ClaudeSdkHarness implements AgentHarness {
  readonly id = HARNESS_CLAUDE_SDK;

  supports(capability: HarnessCapability): boolean {
    return capability === 'supportsSessionResume'
      || capability === 'supportsMcp'
      || capability === 'structuredOutput';
  }

  classifyError(error: unknown, context?: { attemptedResume?: boolean }) {
    const message = errorMessage(error);
    if (
      context?.attemptedResume
      && EXPIRED_SESSION_ERROR_PATTERNS.some((pattern) => pattern.test(message))
    ) {
      return 'session-expired' as const;
    }
    if (SESSION_RESUME_ERROR_PATTERNS.some((pattern) => pattern.test(message))) {
      return 'session-resume-failed' as const;
    }
    return 'unknown' as const;
  }

  async execute(input: HarnessExecuteInput): Promise<HarnessExecuteResult> {
    const setup = pickClaudeSetup(input);
    const prepared = prepareClaudeRun(setup);
    logClaudeRequest('agent.harness.request', 'Agent harness request', setup, prepared, {
      sessionRef: input.sessionRef,
    });
    const drained = await runClaudeQuery(setup, prepared, {
      prompt: input.prompt,
      maxTurns: input.maxTurns,
      sessionRef: input.sessionRef,
      persistSession: true,
      abortController: input.abortController,
      outputSchema: input.outputSchema,
    });
    return { ...drained, sessionRef: input.sessionRef };
  }

  async openScope(setup: HarnessScopeSetup): Promise<HarnessScope> {
    const prepared = prepareClaudeRun(setup);
    logClaudeRequest('agent.harness.scope-open', 'Claude SDK scope opened', setup, prepared);

    let closed = false;
    return {
      async run(input: HarnessScopeRunInput): Promise<HarnessExecuteResult> {
        if (closed) throw new Error('ClaudeSdkHarness: scope.run() called after close()');
        return runClaudeQuery(setup, prepared, {
          prompt: input.prompt,
          maxTurns: input.maxTurns,
          persistSession: false,
          abortController: input.abortController,
        });
      },
      async close(): Promise<void> {
        // The Claude SDK MCP server is in-process — no async resource to
        // release. Just gate further run() calls.
        closed = true;
      },
    };
  }
}

/**
 * Per-setup state both `execute` and `openScope` need: the in-process MCP
 * tool server, the merged env, the resolved Claude Code executable path,
 * and the `localProvider` flag. Computed once per `execute` call (or once
 * per scope, reused across N scope.run calls).
 */
interface PreparedClaudeRun {
  toolServer: ReturnType<typeof buildToolServer>;
  env: Record<string, string | undefined>;
  claudeCodeExecutable: string | undefined;
  localProvider: boolean;
}

interface ClaudeRunOptions {
  prompt: string;
  maxTurns?: number;
  sessionRef?: string;
  persistSession: boolean;
  abortController?: AbortController;
  outputSchema?: HarnessExecuteInput['outputSchema'];
}

/** Narrow an ExecuteInput down to the setup-only fields shared with HarnessScopeSetup. */
function pickClaudeSetup(input: HarnessExecuteInput): HarnessScopeSetup {
  return {
    systemPrompt: input.systemPrompt,
    model: input.model,
    provider: input.provider,
    toolSurface: input.toolSurface,
    logger: input.logger,
    reasoningLevel: input.reasoningLevel,
  };
}

function prepareClaudeRun(setup: HarnessScopeSetup): PreparedClaudeRun {
  const toolServer = buildToolServer({ toolSurface: setup.toolSurface });
  const baseEnv = buildPhaseEnv(setup.provider);
  const env = {
    ...baseEnv,
    MYCO_AGENT_SESSION: '1',
    // Isolate from the user's Claude Code plugin registry — see
    // `getIsolatedPluginCacheDir()` docs. Only honored when the user hasn't
    // overridden the cache dir themselves.
    CLAUDE_CODE_PLUGIN_CACHE_DIR:
      process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? getIsolatedPluginCacheDir(),
  };
  const claudeCodeExecutable = resolveClaudeCodeExecutable();
  if (!claudeCodeExecutable) {
    throw new Error(
      'Claude Code CLI not found. The claude-sdk runtime shells out to the Claude Code CLI, ' +
        'which Myco does not bundle. Install Claude Code (https://claude.com/claude-code), ' +
        'or switch the agent runtime to the OpenAI provider.',
    );
  }
  return {
    toolServer,
    env,
    claudeCodeExecutable,
    localProvider: isLocalProvider(setup.provider),
  };
}

/**
 * Debug-level record of the per-request tool surface. Filtered out unless
 * daemon.log_level is 'debug' — when it is, operators can grep the log
 * viewer for `agent.harness.request` to see what tools each phase actually
 * sent, which is how you catch a plugin leak before it blows up a real run
 * with a 400 tool-schema error.
 */
function logClaudeRequest(
  kind: string,
  message: string,
  setup: HarnessScopeSetup,
  prepared: PreparedClaudeRun,
  extra: { sessionRef?: string } = {},
): void {
  if (!setup.logger) return;
  const mcpToolNames = setup.toolSurface.toolNames
    ?? (prepared.toolServer ? ['<full-vault-surface>'] : []);
  setup.logger.debug(kind, message, {
    runId: setup.toolSurface.runId,
    agentId: setup.toolSurface.agentId,
    model: setup.model,
    mcpToolCount: mcpToolNames.length,
    mcpTools: mcpToolNames,
    pluginCacheDir: prepared.env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
    ...(extra.sessionRef !== undefined ? { sessionRef: extra.sessionRef ?? null } : {}),
  });
}

/**
 * Run a single Claude SDK query against the prepared setup.
 *
 * Always passes `strictMcpConfig: true`, even when the phase wants no
 * MCP tools (e.g., the orchestrator planner with `toolNames: []`).
 * Without strict mode, the SDK falls back to loading every MCP server
 * the user has configured in ~/.claude/mcp.json, ~/.claude.json, and
 * every installed plugin — 130+ unrelated tools leak into the agent's
 * tool surface, inflating context and occasionally triggering API
 * schema rejections (Anthropic's 400 on top-level oneOf/allOf/anyOf).
 *
 * `settingSources: []` completes the isolation: the SDK's plugin-sync
 * path reads `enabledPlugins` from settings.json and syncs them into our
 * isolated plugin cache dir, re-introducing every developer plugin we
 * meant to exclude. Per the SDK docs: "When omitted or empty, no
 * filesystem settings are loaded (SDK isolation mode)."
 */
async function runClaudeQuery(
  setup: HarnessScopeSetup,
  prepared: PreparedClaudeRun,
  options: ClaudeRunOptions,
): Promise<HarnessExecuteResult> {
  const messageStream: AsyncIterable<SDKMessage> = query({
    prompt: options.prompt,
    options: {
      model: setup.model,
      systemPrompt: setup.systemPrompt,
      tools: [],
      mcpServers: prepared.toolServer ? { [MCP_SERVER_NAME]: prepared.toolServer } : {},
      strictMcpConfig: true,
      settingSources: [],
      maxTurns: options.maxTurns,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      persistSession: options.persistSession,
      env: prepared.env,
      thinking: resolveThinkingConfig(setup.reasoningLevel, setup.provider),
      ...(prepared.claudeCodeExecutable ? { pathToClaudeCodeExecutable: prepared.claudeCodeExecutable } : {}),
      ...(options.sessionRef ? { sessionId: options.sessionRef } : {}),
      ...(options.abortController ? { abortController: options.abortController } : {}),
      ...(options.outputSchema ? { outputFormat: { type: 'json_schema' as const, schema: options.outputSchema.schema } } : {}),
    },
  });

  return consumeClaudeMessageStream(messageStream, {
    localProvider: prepared.localProvider,
    sessionRef: options.sessionRef,
  });
}
