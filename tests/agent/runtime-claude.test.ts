import * as __orig__myco_agent_provider_js_1__ns from '@myco/agent/provider.js';
const __orig__myco_agent_provider_js_1 = { ...__orig__myco_agent_provider_js_1__ns };
/**
 * Tests for ClaudeSdkRuntime.execute() covering:
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
}));

mock.module('@myco/agent/provider.js', () => {
  const original = __orig__myco_agent_provider_js_1;
  return {
    ...original,
    buildPhaseEnv: () => ({}),
  };
});

mock.module('@myco/agent/runtime/claude-code-executable.js', () => ({
  resolveClaudeCodeExecutable: () => '/tmp/fake-claude',
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

async function loadRuntime() {
  const mod = await import('@myco/agent/runtime/claude.js');
  return mod.ClaudeSdkRuntime;
}

function makeInput(overrides: Partial<import('@myco/agent/runtime/types.js').RuntimeExecuteInput> = {}) {
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

describe('ClaudeSdkRuntime.execute', () => {
  beforeEach(() => {
    queryCalls.length = 0;
    scopedServerCalls.length = 0;
    fullServerCalls.length = 0;
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
});
