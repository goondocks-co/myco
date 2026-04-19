import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { RuntimeExecuteInput, RuntimeExecuteResult, AgentRuntime, RuntimeCapability } from './types.js';
import { RuntimeExecutionError } from './types.js';
import { createScopedVaultToolServer, createVaultToolServer } from '@myco/agent/tools.js';
import { buildPhaseEnv } from '@myco/agent/provider.js';

const MCP_SERVER_NAME = 'myco-vault';

/**
 * Per-process isolated plugin cache directory for agent runs. The Claude
 * SDK reads `~/.claude/plugins/installed_plugins.json` by default, which
 * pulls in every plugin the user has installed in their developer Claude
 * Code — dozens of extra tools we didn't register, some with schemas
 * Anthropic's API now rejects (top-level `oneOf`/`allOf`/`anyOf`). Setting
 * `CLAUDE_CODE_PLUGIN_CACHE_DIR` to an empty directory gives the agent a
 * clean, deterministic tool surface: only our MCP vault tools.
 *
 * Created once per daemon process and reused across runs.
 */
let isolatedPluginCacheDir: string | undefined;

function getIsolatedPluginCacheDir(): string {
  if (isolatedPluginCacheDir) return isolatedPluginCacheDir;
  const dir = path.join(os.tmpdir(), `myco-agent-plugin-cache-${process.pid}`);
  fs.mkdirSync(dir, { recursive: true });
  isolatedPluginCacheDir = dir;
  return dir;
}

function buildToolServer(input: RuntimeExecuteInput) {
  const { toolSurface } = input;
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

export class ClaudeSdkRuntime implements AgentRuntime {
  readonly id = 'claude-sdk' as const;

  supports(capability: RuntimeCapability): boolean {
    return capability === 'supportsSessionResume' || capability === 'supportsMcp';
  }

  async execute(input: RuntimeExecuteInput): Promise<RuntimeExecuteResult> {
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

    let finalText = '';
    let turnsUsed = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let assistantMessages = 0;

    // Always pass `strictMcpConfig: true`, even when the phase wants no
    // MCP tools (e.g., the orchestrator planner with `toolNames: []`).
    // Without strict mode, the SDK falls back to loading every MCP server
    // the user has configured in ~/.claude/mcp.json, ~/.claude.json, and
    // every installed plugin — 130+ unrelated tools leak into the agent's
    // tool surface, inflating context and occasionally triggering API
    // schema rejections (Anthropic's 400 on top-level oneOf/allOf/anyOf).
    const messageStream: AsyncIterable<SDKMessage> = query({
      prompt: input.prompt,
      options: {
        model: input.model,
        systemPrompt: input.systemPrompt,
        tools: [],
        mcpServers: toolServer ? { [MCP_SERVER_NAME]: toolServer } : {},
        strictMcpConfig: true,
        maxTurns: input.maxTurns,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        persistSession: true,
        env,
        ...(input.sessionRef ? { sessionId: input.sessionRef } : {}),
        ...(input.abortController ? { abortController: input.abortController } : {}),
      },
    });

    const buildUsage = () => ({
      requests: turnsUsed,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      costUsd,
      requestUsageEntries: turnsUsed > 0
        ? [{
            inputTokens,
            outputTokens,
            totalTokens: inputTokens + outputTokens,
          }]
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
          costUsd = message.total_cost_usd ?? 0;
          if (message.subtype === 'success') {
            finalText = message.result;
          }
        }
      }
    } catch (err) {
      if (turnsUsed > 0 || inputTokens > 0 || outputTokens > 0) {
        throw new RuntimeExecutionError(
          err instanceof Error ? err.message : String(err),
          { usage: buildUsage(), sessionRef: input.sessionRef },
          { cause: err },
        );
      }
      throw err;
    }

    return {
      finalText,
      turnsUsed,
      usage: buildUsage(),
      sessionRef: input.sessionRef,
    };
  }
}
