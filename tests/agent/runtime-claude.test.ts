import * as __orig__myco_agent_provider_js_1__ns from '@myco/agent/provider.js';
const __orig__myco_agent_provider_js_1 = { ...__orig__myco_agent_provider_js_1__ns };
/**
 * Tests for ClaudeSdkHarness.execute() covering:
 *   - session ref forwarding (sessionId is passed through to the SDK)
 *   - abortController forwarded when present
 *   - scoped tool server created with toolNames + dryRun
 *   - usage aggregation from the result message
 */

import { describe, expect, it, beforeEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
// ---------------------------------------------------------------------------
// Mock: claude-agent-sdk.query — capture args, control the stream
// ---------------------------------------------------------------------------

const queryCalls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
let structuredOutputOverride: unknown = undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args);
    return {
      [Symbol.asyncIterator]: async function* () {
        yield {
          type: 'assistant' as const,
          message: { role: 'assistant', content: 'thinking' },
          uuid: 'a-1',
          session_id: 'test-session',
        };
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          total_cost_usd: 0.0123,
          usage: { input_tokens: 42, output_tokens: 7 },
          num_turns: 1,
          duration_ms: 100,
          duration_api_ms: 80,
          is_error: false,
          result: 'final response',
          stop_reason: 'end_turn',
          modelUsage: {},
          permission_denials: [],
          uuid: 'r-1',
          session_id: 'test-session',
          ...(structuredOutputOverride !== undefined ? { structured_output: structuredOutputOverride } : {}),
        };
      },
    };
  },
  createSdkMcpServer: (opts: Record<string, unknown>) => ({
    type: 'sdk' as const,
    instance: {},
    ...opts,
  }),
  tool: (_name: string, _desc: string, _schema: unknown, handler: unknown) => ({
    name: _name,
    handler,
  }),
}));

// ---------------------------------------------------------------------------
// Mock: tool server constructors — capture options (dryRun, toolNames, ...)
// ---------------------------------------------------------------------------

const scopedServerCalls: Array<{ agentId: string; runId: string; toolNames: string[]; options: Record<string, unknown> }> = [];
const fullServerCalls: Array<{ agentId: string; runId: string; options: Record<string, unknown> }> = [];

mock.module('@myco/agent/tools.js', () => ({
  createVaultToolServer: (agentId: string, runId: string, options: Record<string, unknown> = {}) => {
    fullServerCalls.push({ agentId, runId, options });
    return { type: 'sdk' as const, name: 'myco-vault', instance: {} };
  },
  createScopedVaultToolServer: (agentId: string, runId: string, toolNames: string[], options: Record<string, unknown> = {}) => {
    scopedServerCalls.push({ agentId, runId, toolNames, options });
    return { type: 'sdk' as const, name: 'myco-vault', instance: {} };
  },
  createMaterializedVaultToolServer: (_tools: unknown[]) => ({
    type: 'sdk' as const,
    name: 'myco-vault',
    instance: {},
  }),
}));

mock.module('@myco/agent/provider.js', () => {
  const original = __orig__myco_agent_provider_js_1;
  return {
    ...original,
    buildPhaseEnv: () => ({}),
  };
});

mock.module('@myco/agent/harness/claude-code-executable.js', () => ({
  resolveClaudeCodeExecutable: () => '/tmp/fake-claude',
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/harness/claude.js');
  return mod.ClaudeSdkHarness;
}

function makeInput(overrides: Partial<import('@myco/agent/harness/types.js').HarnessExecuteInput> = {}) {
  return {
    prompt: 'Do the thing.',
    model: 'claude-sonnet-4-6',
    maxTurns: 5,
    systemPrompt: 'You are a test agent.',
    toolSurface: {
      agentId: 'test-agent',
      runId: 'test-run',
      toolNames: ['vault_report'],
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ClaudeSdkHarness.execute', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    scopedServerCalls.length = 0;
    fullServerCalls.length = 0;
    structuredOutputOverride = undefined;
  });

  it('forwards sessionRef as sessionId to the SDK when provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput({ sessionRef: 'sess-abc' }));

    expect(queryCalls[0].options.sessionId).toBe('sess-abc');
    expect(result.sessionRef).toBe('sess-abc');
  });

  it('omits sessionId when no sessionRef is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect('sessionId' in queryCalls[0].options).toBe(false);
  });

  it('forwards abortController to the SDK when present', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const controller = new AbortController();
    await runtime.execute(makeInput({ abortController: controller }));

    expect(queryCalls[0].options.abortController).toBe(controller);
  });

  it('passes the resolved Claude Code executable path to the SDK', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect(queryCalls[0].options.pathToClaudeCodeExecutable).toBe('/tmp/fake-claude');
  });

  it('omits abortController when not supplied', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect('abortController' in queryCalls[0].options).toBe(false);
  });

  it('constructs a scoped tool server when toolSurface.toolNames is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        dryRun: true,
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].toolNames).toEqual(['vault_report']);
    expect(scopedServerCalls[0].options.dryRun).toBe(true);
    expect(fullServerCalls).toHaveLength(0);
  });

  it('constructs the full vault tool server when toolNames is omitted', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1' },
    }));

    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].agentId).toBe('a1');
    expect(fullServerCalls[0].runId).toBe('r1');
    expect(scopedServerCalls).toHaveLength(0);
  });

  it('threads hooks/hookContext through to createScopedVaultToolServer when toolNames is provided', async () => {
    // Regression: buildToolServer used to omit hooks/hookContext on the
    // createScopedVaultToolServer call, so wrapToolWithAudit inside
    // tools.ts always received undefined for agent-mode phases — no
    // pre_tool_use/post_tool_use events were ever recorded in production
    // even when a run had real hooks configured.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const hooks = { preToolUse: async () => {} };
    const hookContext = { runId: 'r1', agentId: 'a1', harnessId: 'claude-sdk' as const, phaseName: 'gather' };

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        hooks,
        hookContext,
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.hooks).toBe(hooks);
    expect(scopedServerCalls[0].options.hookContext).toEqual(hookContext);
  });

  it('threads hooks/hookContext through to createVaultToolServer when toolNames is omitted', async () => {
    // Same regression as above, for the single-query / orchestrator path
    // that hits the full (unscoped) vault tool server.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const hooks = { phaseStart: async () => {} };
    const hookContext = { runId: 'r1', agentId: 'a1', harnessId: 'claude-sdk' as const };

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', hooks, hookContext },
    }));

    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.hooks).toBe(hooks);
    expect(fullServerCalls[0].options.hookContext).toEqual(hookContext);
  });

  it('isolates the agent from user settings via settingSources: []', async () => {
    // Regression: the SDK's plugin-sync path reads `enabledPlugins` from
    // ~/.claude/settings.json / project .claude/settings.json when
    // settingSources is unset, and hydrates the "isolated" plugin cache
    // with every enabled developer plugin (observed 21 plugins leaking
    // through on a dev machine 2026-04-19). Per the SDK docs:
    // "When omitted or empty, no filesystem settings are loaded (SDK
    // isolation mode)."
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect(queryCalls[0].options.settingSources).toEqual([]);
  });

  it('passes an empty mcpServers + strictMcpConfig when toolNames is an empty list', async () => {
    // Even when the phase wants no vault tools (e.g., the orchestrator
    // planner with toolNames: []), we MUST still pass strictMcpConfig:
    // true with an empty mcpServers map — otherwise the SDK falls back
    // to loading every MCP server the user has configured in
    // ~/.claude/mcp.json and every installed plugin (130+ tools leak).
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: [] },
    }));

    expect(queryCalls[0].options.mcpServers).toEqual({});
    expect(queryCalls[0].options.strictMcpConfig).toBe(true);
    expect(scopedServerCalls).toHaveLength(0);
    expect(fullServerCalls).toHaveLength(0);
  });

  it('pre-seeds the isolated plugin cache dir with an empty manifest', async () => {
    // Regression: CLAUDE_CODE_PLUGIN_CACHE_DIR isolates the directory but
    // the SDK otherwise populates it from ~/.claude/plugins on first use,
    // re-introducing user plugins whose tool schemas Anthropic's API
    // rejects (top-level oneOf/allOf/anyOf). Writing an empty manifest
    // before the SDK starts short-circuits the sync.
    const fs = await import('node:fs');
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    const cacheDir = queryCalls[0].options.env as Record<string, string>;
    const dir = cacheDir.CLAUDE_CODE_PLUGIN_CACHE_DIR;
    expect(dir).toBeTruthy();
    const manifestPath = `${dir}/installed_plugins.json`;
    expect(fs.existsSync(manifestPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    expect(parsed.plugins).toEqual({});
  });

  it('aggregates usage from the final result message', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput());
    expect(result.finalText).toBe('final response');
    expect(result.turnsUsed).toBe(1);
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.totalTokens).toBe(49);
    expect(result.usage.costUsd).toBeCloseTo(0.0123);
    expect(result.usage.requestUsageEntries).toHaveLength(1);
  });

  it('attaches outputFormat to the SDK call when outputSchema is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    await runtime.execute({
      prompt: 'plan the phases',
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
      outputSchema: { name: 'orchestrator_plan', schema: { type: 'object', properties: {} } },
    });
    const lastCall = queryCalls[queryCalls.length - 1];
    expect(lastCall.options.outputFormat).toEqual({
      type: 'json_schema',
      schema: { type: 'object', properties: {} },
    });
  });

  it('omits outputFormat when outputSchema is not provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    await runtime.execute({
      prompt: 'do something',
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    });
    const lastCall = queryCalls[queryCalls.length - 1];
    expect(lastCall.options.outputFormat).toBeUndefined();
  });

  it('returns structuredOutput from the result message when present', async () => {
    structuredOutputOverride = { phases: [{ name: 'extract', skip: false }], reasoning: 'ok' };
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const result = await runtime.execute({
      prompt: 'plan the phases',
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
      outputSchema: { name: 'orchestrator_plan', schema: { type: 'object', properties: {} } },
    });
    expect(result.structuredOutput).toEqual({ phases: [{ name: 'extract', skip: false }], reasoning: 'ok' });
  });

  it('leaves structuredOutput undefined when the SDK never emits structured_output', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const result = await runtime.execute({
      prompt: 'do something',
      model: 'claude-sonnet-4-6',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    });
    expect(result.structuredOutput).toBeUndefined();
  });
});

describe('ClaudeSdkHarness.supports', () => {
  it('reports structuredOutput support', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    expect(runtime.supports('structuredOutput')).toBe(true);
  });
});

describe('ClaudeSdkHarness.execute — thinking-config wiring', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    scopedServerCalls.length = 0;
    fullServerCalls.length = 0;
    structuredOutputOverride = undefined;
  });

  it('resolves reasoningLevel "high" to an enabled thinking budget for an anthropic provider', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      reasoningLevel: 'high',
      provider: { type: 'anthropic' },
    }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'enabled', budgetTokens: 32000 });
  });

  it('defaults to adaptive thinking when reasoningLevel is omitted for a non-local provider', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({ provider: { type: 'anthropic' } }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'adaptive' });
  });

  it('defaults to adaptive thinking when no provider is supplied at all', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput());

    expect(queryCalls[0].options.thinking).toEqual({ type: 'adaptive' });
  });

  it('honors a provider thinkingBudgetMap override for a non-local provider', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      reasoningLevel: 'low',
      provider: {
        type: 'anthropic',
        thinkingBudgetMap: { low: { budgetTokens: 2048 } },
      },
    }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'enabled', budgetTokens: 2048 });
  });

  it('forces disabled thinking for a local (ollama) provider even with a thinkingBudgetMap configured and reasoningLevel "high"', async () => {
    // Regression: suppressEffortLeakForLocalProvider used to force
    // `{ type: 'disabled' }` unconditionally for local providers, before
    // any tier-based thinking logic ran. resolveThinkingConfig must
    // preserve that ordering — a local provider's thinkingBudgetMap
    // override (if one is even configured) must never leak a non-disabled
    // thinking config to an endpoint that can't parse the SDK's reasoning
    // fields.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      reasoningLevel: 'high',
      provider: {
        type: 'ollama',
        thinkingBudgetMap: { high: { budgetTokens: 32000 } },
      },
    }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'disabled' });
  });

  it('forces disabled thinking for a local (lmstudio) provider regardless of reasoningLevel', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      reasoningLevel: 'low',
      provider: { type: 'lmstudio' },
    }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'disabled' });
  });

  it('forces disabled thinking for a local (openai-compatible) provider regardless of reasoningLevel', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      reasoningLevel: 'default',
      provider: { type: 'openai-compatible' },
    }));

    expect(queryCalls[0].options.thinking).toEqual({ type: 'disabled' });
  });
});
