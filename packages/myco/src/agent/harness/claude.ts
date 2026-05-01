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
import { HarnessExecutionError } from './types.js';
import { HARNESS_CLAUDE_SDK } from '@myco/agent/types.js';
import {
  createMaterializedVaultToolServer,
  createScopedVaultToolServer,
  createVaultToolServer,
} from '@myco/agent/tools.js';
import { buildPhaseEnv, isLocalProvider } from '@myco/agent/provider.js';
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

/** Disable thinking on local providers whose endpoints don't accept the SDK's reasoning enum. */
function suppressEffortLeakForLocalProvider(
  provider?: HarnessExecuteInput['provider'],
): { thinking?: { type: 'disabled' } } {
  return isLocalProvider(provider) ? { thinking: { type: 'disabled' as const } } : {};
}

/**
 * Drain a Claude SDK message stream into a final text + usage tally.
 *
 * Both `execute` and `openScope.run` produce identical message-stream
 * shapes — only their `query()` options differ (resume + persistSession in
 * `execute`, fresh + ephemeral in `openScope`). Centralizing the loop
 * keeps usage accounting, partial-usage rescue on stream errors, and the
 * assistant-message turn fallback consistent across both paths; without it
 * the two had already drifted (e.g., `assistantMessages` rescue was added
 * to one and not the other).
 */
async function consumeClaudeMessageStream(
  messageStream: AsyncIterable<SDKMessage>,
  options: { localProvider: boolean; sessionRef?: string },
): Promise<{ finalText: string; turnsUsed: number; usage: HarnessExecuteResult['usage'] }> {
  let finalText = '';
  let turnsUsed = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let assistantMessages = 0;

  const buildUsage = () => ({
    requests: turnsUsed,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
    costUsd,
    requestUsageEntries: turnsUsed > 0
      ? [{ inputTokens, outputTokens, totalTokens: inputTokens + outputTokens }]
      : [],
  });

  try {
    for await (const message of messageStream) {
      if (message.type === 'assistant') {
        assistantMessages += 1;
        continue;
      }
      if (message.type === 'result') {
        // Capture usage on any subtype — error variants still burn tokens.
        // finalText only exists on a successful result.
        turnsUsed = message.num_turns ?? assistantMessages;
        inputTokens = message.usage?.input_tokens ?? 0;
        outputTokens = message.usage?.output_tokens ?? 0;
        costUsd = options.localProvider ? 0 : (message.total_cost_usd ?? 0);
        if (message.subtype === 'success') {
          finalText = message.result;
        }
      }
    }
  } catch (err) {
    if (turnsUsed > 0 || inputTokens > 0 || outputTokens > 0) {
      throw new HarnessExecutionError(
        errorMessage(err),
        { usage: buildUsage(), ...(options.sessionRef ? { sessionRef: options.sessionRef } : {}) },
        { cause: err },
      );
    }
    throw err;
  }

  return { finalText, turnsUsed, usage: buildUsage() };
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
        embeddingManager: toolSurface.embeddingManager,
        readOnly: toolSurface.readOnly,
        dryRun: toolSurface.dryRun,
      },
    );
  }

  return createVaultToolServer(toolSurface.agentId, toolSurface.runId, {
    embeddingManager: toolSurface.embeddingManager,
    vaultDir: toolSurface.vaultDir,
    dryRun: toolSurface.dryRun,
  });
}

export class ClaudeSdkHarness implements AgentHarness {
  readonly id = HARNESS_CLAUDE_SDK;

  supports(capability: HarnessCapability): boolean {
    return capability === 'supportsSessionResume' || capability === 'supportsMcp';
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
    const toolServer = buildToolServer(input);
    const baseEnv = buildPhaseEnv(input.provider);
    const env = {
      ...(baseEnv ?? process.env),
      MYCO_AGENT_SESSION: '1',
      // Isolate from the user's Claude Code plugin registry — see
      // `getIsolatedPluginCacheDir()` docs above. Only honored when the
      // user hasn't explicitly overridden the cache dir themselves.
      CLAUDE_CODE_PLUGIN_CACHE_DIR:
        process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? getIsolatedPluginCacheDir(),
    };

    // Debug-level record of the per-request tool surface. Filtered out
    // unless daemon.log_level is set to 'debug' — when it is, operators
    // can grep the log viewer for `agent.harness.request` to see what
    // tools each phase actually sent, which is how you catch a plugin
    // leak before it blows up a real run with a 400 tool-schema error.
    if (input.logger) {
      const mcpToolNames = input.toolSurface.toolNames
        ?? (toolServer ? ['<full-vault-surface>'] : []);
      input.logger.debug('agent.harness.request', 'Agent harness request', {
        runId: input.toolSurface.runId,
        agentId: input.toolSurface.agentId,
        model: input.model,
        mcpToolCount: mcpToolNames.length,
        mcpTools: mcpToolNames,
        pluginCacheDir: env.CLAUDE_CODE_PLUGIN_CACHE_DIR,
        sessionRef: input.sessionRef ?? null,
      });
    }

    const claudeCodeExecutable = resolveClaudeCodeExecutable();
    const localProvider = isLocalProvider(input.provider);

    // Always pass `strictMcpConfig: true`, even when the phase wants no
    // MCP tools (e.g., the orchestrator planner with `toolNames: []`).
    // Without strict mode, the SDK falls back to loading every MCP server
    // the user has configured in ~/.claude/mcp.json, ~/.claude.json, and
    // every installed plugin — 130+ unrelated tools leak into the agent's
    // tool surface, inflating context and occasionally triggering API
    // schema rejections (Anthropic's 400 on top-level oneOf/allOf/anyOf).
    //
    // `settingSources: []` completes the isolation: the SDK's plugin-sync
    // path reads `enabledPlugins` from `~/.claude/settings.json` / project
    // settings and syncs them into our "isolated" plugin cache dir,
    // re-introducing every developer plugin we meant to exclude. Per the
    // SDK docs: "When omitted or empty, no filesystem settings are
    // loaded (SDK isolation mode)."
    const messageStream: AsyncIterable<SDKMessage> = query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: [],
        mcpServers: toolServer ? { [MCP_SERVER_NAME]: toolServer } : {},
        strictMcpConfig: true,
        settingSources: [],
        maxTurns: input.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        env,
        ...suppressEffortLeakForLocalProvider(input.provider),
        ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
        ...(input.sessionRef ? { sessionId: input.sessionRef } : {}),
        ...(input.abortController ? { abortController: input.abortController } : {}),
      },
    });

    const drained = await consumeClaudeMessageStream(messageStream, {
      localProvider,
      sessionRef: input.sessionRef,
    });

    return {
      ...drained,
      sessionRef: input.sessionRef,
    };
  }

  async openScope(setup: HarnessScopeSetup): Promise<HarnessScope> {
    const toolServer = buildToolServer({ toolSurface: setup.toolSurface });
    const claudeCodeExecutable = resolveClaudeCodeExecutable();
    const baseEnv = buildPhaseEnv(setup.provider);
    const env = {
      ...(baseEnv ?? process.env),
      MYCO_AGENT_SESSION: '1',
      CLAUDE_CODE_PLUGIN_CACHE_DIR:
        process.env.CLAUDE_CODE_PLUGIN_CACHE_DIR ?? getIsolatedPluginCacheDir(),
    };
    const localProvider = isLocalProvider(setup.provider);

    if (setup.logger) {
      const mcpToolNames = setup.toolSurface.toolNames
        ?? (toolServer ? ['<full-vault-surface>'] : []);
      setup.logger.debug('agent.harness.scope-open', 'Claude SDK scope opened', {
        runId: setup.toolSurface.runId,
        agentId: setup.toolSurface.agentId,
        model: setup.model,
        mcpToolCount: mcpToolNames.length,
        mcpTools: mcpToolNames,
      });
    }

    let closed = false;

    return {
      async run(input: HarnessScopeRunInput): Promise<HarnessExecuteResult> {
        if (closed) throw new Error('ClaudeSdkHarness: scope.run() called after close()');

        const messageStream: AsyncIterable<SDKMessage> = query({
          prompt: input.prompt,
          options: {
            model: setup.model,
            systemPrompt: setup.systemPrompt,
            tools: [],
            mcpServers: toolServer ? { [MCP_SERVER_NAME]: toolServer } : {},
            strictMcpConfig: true,
            settingSources: [],
            maxTurns: input.maxTurns,
            permissionMode: 'bypassPermissions',
            allowDangerouslySkipPermissions: true,
            persistSession: false,
            env,
            ...suppressEffortLeakForLocalProvider(setup.provider),
            ...(claudeCodeExecutable ? { pathToClaudeCodeExecutable: claudeCodeExecutable } : {}),
            ...(input.abortController ? { abortController: input.abortController } : {}),
          },
        });

        return consumeClaudeMessageStream(messageStream, { localProvider });
      },
      async close(): Promise<void> {
        // The Claude SDK MCP server is in-process — no async resource to
        // release. Just gate further run() calls.
        if (closed) return;
        closed = true;
      },
    };
  }
}
