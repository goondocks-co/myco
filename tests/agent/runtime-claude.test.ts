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
let usageOverride: Record<string, number> | undefined = undefined;
// Override for multi-turn fixtures: an array of raw per-message usage
// snapshots (BetaUsage shape). When set, the mock emits one `assistant`
// message per entry, each carrying `message.usage` — the real SDK's
// per-request usage field — instead of the default single content-only
// assistant message with no usage.
let assistantUsageSequenceOverride: Array<Record<string, number>> | undefined = undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: string; options: Record<string, unknown> }) => {
    queryCalls.push(args);
    return {
      [Symbol.asyncIterator]: async function* () {
        if (assistantUsageSequenceOverride) {
          for (const [i, usage] of assistantUsageSequenceOverride.entries()) {
            yield {
              type: 'assistant' as const,
              message: { role: 'assistant', content: 'thinking', usage },
              uuid: `a-${i + 1}`,
              session_id: 'test-session',
            };
          }
        } else {
          yield {
            type: 'assistant' as const,
            message: { role: 'assistant', content: 'thinking' },
            uuid: 'a-1',
            session_id: 'test-session',
          };
        }
        yield {
          type: 'result' as const,
          subtype: 'success' as const,
          total_cost_usd: 0.0123,
          usage: usageOverride ?? { input_tokens: 42, output_tokens: 7 },
          num_turns: assistantUsageSequenceOverride?.length ?? 1,
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
    usageOverride = undefined;
    assistantUsageSequenceOverride = undefined;
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

  it('threads phasePurpose through to createScopedVaultToolServer when toolNames is provided', async () => {
    // Regression: buildToolServer used to omit phasePurpose on the
    // createScopedVaultToolServer call, so the semantic-check wrapper inside
    // tools.ts would never see the phase's declared name/prompt excerpt
    // for agent-mode phases — the classifier would fail to validate
    // destructive writes against the actual phase intent in production.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const phasePurpose = { name: 'gather', promptExcerpt: 'collect all available facts' };

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        phasePurpose,
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.phasePurpose).toEqual(phasePurpose);
  });

  it('threads phasePurpose through to createVaultToolServer when toolNames is omitted', async () => {
    // Regression: buildToolServer used to omit phasePurpose on the
    // createVaultToolServer call for the single-query/orchestrator path.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const phasePurpose = { name: 'plan', promptExcerpt: 'decompose into phases' };

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', phasePurpose },
    }));

    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.phasePurpose).toEqual(phasePurpose);
  });

  it('threads semanticCheckEnabled/harnessId/model/classifierReasoningLevel through to createScopedVaultToolServer when toolNames is provided', async () => {
    // Regression: buildToolServer used to omit the semantic-check gate
    // fields on the createScopedVaultToolServer call, so
    // wrapToolWithSemanticCheck inside tools.ts would never see them for
    // agent-mode phases even when config.semanticWriteCheckEnabled is on.
    // classifierReasoningLevel is the same class of regression: snapshotted
    // onto the run row by Task 2b but never threaded past EffectiveConfig,
    // so every classifier call silently used 'low' regardless of override.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        semanticCheckEnabled: true,
        harnessId: 'claude-sdk',
        model: 'claude-sonnet-4-6',
        classifierReasoningLevel: 'high',
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.semanticCheckEnabled).toBe(true);
    expect(scopedServerCalls[0].options.harnessId).toBe('claude-sdk');
    expect(scopedServerCalls[0].options.model).toBe('claude-sonnet-4-6');
    expect(scopedServerCalls[0].options.classifierReasoningLevel).toBe('high');
  });

  it('threads semanticCheckEnabled/harnessId/model/classifierReasoningLevel through to createVaultToolServer when toolNames is omitted', async () => {
    // Same regression as above, for the single-query / orchestrator path
    // that hits the full (unscoped) vault tool server.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        semanticCheckEnabled: true,
        harnessId: 'claude-sdk',
        model: 'claude-sonnet-4-6',
        classifierReasoningLevel: 'high',
      },
    }));

    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.semanticCheckEnabled).toBe(true);
    expect(fullServerCalls[0].options.harnessId).toBe('claude-sdk');
    expect(fullServerCalls[0].options.model).toBe('claude-sonnet-4-6');
    expect(fullServerCalls[0].options.classifierReasoningLevel).toBe('high');
  });

  it('leaves semanticCheckEnabled/harnessId/model/classifierReasoningLevel undefined on both server paths when absent from toolSurface', async () => {
    // Regression proof: disabled/absent gate fields must be byte-identical
    // to pre-Task-8 behavior — no accidental default flips the gate on.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: ['vault_report'] },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.semanticCheckEnabled).toBeUndefined();
    expect(scopedServerCalls[0].options.harnessId).toBeUndefined();
    expect(scopedServerCalls[0].options.model).toBeUndefined();
    expect(scopedServerCalls[0].options.classifierReasoningLevel).toBeUndefined();
  });

  it('threads provider through to createScopedVaultToolServer and createVaultToolServer', async () => {
    // I1 regression: buildToolServer omitted toolSurface.provider on both
    // tool-server construction branches, so wrapToolWithSemanticCheck
    // (tools.ts) never had the phase's actual provider to pass to
    // classifyWriteIntent — on a provider-override setup (Ollama/custom
    // baseURL) the classifier silently built its harness call against the
    // DEFAULT provider env instead, which errors and permanently fails
    // open for the whole run.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const provider = { type: 'ollama' as const, baseUrl: 'http://localhost:11434', model: 'llama3' };

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: ['vault_report'], provider },
    }));
    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.provider).toEqual(provider);

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', provider },
    }));
    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.provider).toEqual(provider);
  });

  it('threads flaggedWritesAccumulator through to createScopedVaultToolServer and createVaultToolServer', async () => {
    // C2 regression: buildToolServer omitted toolSurface.flaggedWritesAccumulator
    // on both branches, so wrapToolWithSemanticCheck had nowhere to record
    // a flagged write for executePhase to read back — the phase could
    // complete "successfully" after a blocked destructive write.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const flaggedWritesAccumulator: Array<{ toolName: string; reason: string | null }> = [];

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: ['vault_report'], flaggedWritesAccumulator },
    }));
    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.flaggedWritesAccumulator).toBe(flaggedWritesAccumulator);

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', flaggedWritesAccumulator },
    }));
    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.flaggedWritesAccumulator).toBe(flaggedWritesAccumulator);
  });

  it('threads deferredNames through to createScopedVaultToolServer when toolNames is provided', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        toolNames: ['vault_report'],
        deferredNames: ['vault_report'],
      },
    }));

    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.deferredNames).toEqual(new Set(['vault_report']));
  });

  it('threads deferredNames through to createVaultToolServer when toolNames is omitted (P3-T1 fix — FULL-SURFACE path)', async () => {
    // Prior to this fix, buildToolServer's FULL-SURFACE branch (the one
    // executeSingleQuery hits for the five single-query tasks — no
    // toolNames means the whole 39-tool registry ships every run) never
    // read toolSurface.deferredNames at all: it built the
    // createVaultToolServer options object without a deferredNames key.
    // A task-level `deferredTools` (P3-T1's new AgentTaskSchema field)
    // would therefore reach the phase-loop's toolSurface correctly and
    // then silently no-op the moment it hit the harness adapter — no
    // stub, no vault_search_tools, full undeferred payload every time.
    // This test would have failed before the claude.ts fix; it must pass
    // now that createVaultToolServer's options Pick (tools.ts) includes
    // 'deferredNames' and the full-surface branch threads it.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: {
        agentId: 'a1',
        runId: 'r1',
        deferredNames: ['vault_report'],
      },
    }));

    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.deferredNames).toEqual(new Set(['vault_report']));
  });

  it('leaves deferredNames undefined on both server paths when absent from toolSurface', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1', toolNames: ['vault_report'] },
    }));
    expect(scopedServerCalls).toHaveLength(1);
    expect(scopedServerCalls[0].options.deferredNames).toBeUndefined();

    await runtime.execute(makeInput({
      toolSurface: { agentId: 'a1', runId: 'r1' },
    }));
    expect(fullServerCalls).toHaveLength(1);
    expect(fullServerCalls[0].options.deferredNames).toBeUndefined();
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

  it('leaves cachedTokens at 0 and inputTokens unchanged when the SDK usage carries no cache fields (backward compat)', async () => {
    // The fixture above (`makeInput()`'s default query mock) only sets
    // input_tokens/output_tokens — no cache_creation_input_tokens or
    // cache_read_input_tokens. Pre-existing runs (and any SDK response
    // that genuinely has no cache activity) must produce identical
    // inputTokens/totalTokens to before this fix, with cachedTokens
    // reported as 0 rather than left undefined.
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput());
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
    expect(result.usage.cachedTokens).toBe(0);
    expect(result.usage.totalTokens).toBe(49);
  });

  it('folds cache_creation_input_tokens and cache_read_input_tokens into inputTokens and reports cache_read as cachedTokens', async () => {
    // SDK usage shape carrying cache fields (BetaUsage on
    // SDKResultMessage.usage): input_tokens excludes both cache_creation
    // and cache_read — this fixture models a request where the large
    // tool-schema payload was served from cache. inputTokens must be the
    // full prompt size (sdk.input_tokens + cache_creation + cache_read) so
    // cost/breakdown.ts's uncachedInputTokens = inputTokens - cachedTokens
    // subtraction stays meaningful; cachedTokens is the cache_read portion
    // only.
    usageOverride = {
      input_tokens: 100,
      output_tokens: 20,
      cache_creation_input_tokens: 5000,
      cache_read_input_tokens: 3000,
    };
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput());
    expect(result.usage.inputTokens).toBe(100 + 5000 + 3000);
    expect(result.usage.cachedTokens).toBe(3000);
    expect(result.usage.outputTokens).toBe(20);
    expect(result.usage.totalTokens).toBe(100 + 5000 + 3000 + 20);

    const { buildTokenBreakdown } = await import('@myco/agent/cost/breakdown.js');
    const breakdown = buildTokenBreakdown(result.usage);
    expect(breakdown.cachedInputTokens).toBe(3000);
    expect(breakdown.uncachedInputTokens).toBe(100 + 5000 + 3000 - 3000);
    expect(breakdown.uncachedInputTokens).toBeGreaterThanOrEqual(0);
  });

  it('keeps breakdown.uncachedInputTokens non-negative for the no-cache-fields fixture', async () => {
    const Runtime = await loadRuntime();
    const runtime = new Runtime();

    const result = await runtime.execute(makeInput());
    const { buildTokenBreakdown } = await import('@myco/agent/cost/breakdown.js');
    const breakdown = buildTokenBreakdown(result.usage);
    expect(breakdown.cachedInputTokens).toBe(0);
    expect(breakdown.uncachedInputTokens).toBe(42);
    expect(breakdown.uncachedInputTokens).toBeGreaterThanOrEqual(0);
  });

  it('emits one requestUsageEntries entry per assistant message on a multi-turn run, summing to the run totals', async () => {
    // Each SDK assistant message carries its own BetaUsage snapshot — a
    // genuine per-request peak, not the run-cumulative total the terminal
    // `result` message reports. Three turns, each re-reading a cached
    // prompt (mirrors real multi-turn agent conversations under prompt
    // caching): entries.length must equal turn count, each entry's own
    // composition must be correct, and the entries must sum to the run
    // totals — run totals are untouched by this fix.
    assistantUsageSequenceOverride = [
      { input_tokens: 50, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      { input_tokens: 10, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 400 },
      { input_tokens: 15, output_tokens: 45, cache_creation_input_tokens: 0, cache_read_input_tokens: 420 },
    ];
    usageOverride = {
      input_tokens: 75,
      output_tokens: 95,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 820,
    };

    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const result = await runtime.execute(makeInput());

    expect(result.turnsUsed).toBe(3);
    const entries = result.usage.requestUsageEntries as Array<{
      inputTokens: number;
      outputTokens: number;
      cachedTokens: number;
      totalTokens: number;
    }>;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({ inputTokens: 50, outputTokens: 20, cachedTokens: 0, totalTokens: 70 });
    expect(entries[1]).toEqual({ inputTokens: 410, outputTokens: 30, cachedTokens: 400, totalTokens: 440 });
    expect(entries[2]).toEqual({ inputTokens: 435, outputTokens: 45, cachedTokens: 420, totalTokens: 480 });

    const sumInput = entries.reduce((sum, e) => sum + e.inputTokens, 0);
    const sumOutput = entries.reduce((sum, e) => sum + e.outputTokens, 0);
    expect(sumInput).toBe(result.usage.inputTokens);
    expect(sumOutput).toBe(result.usage.outputTokens);

    // Run totals unchanged: still sourced from the terminal result message.
    expect(result.usage.inputTokens).toBe(75 + 0 + 820);
    expect(result.usage.outputTokens).toBe(95);
    expect(result.usage.cachedTokens).toBe(820);
    expect(result.usage.costUsd).toBeCloseTo(0.0123);

    // Peak-over-entries is far below the cumulative run total — the bug
    // this fix closes.
    const peak = Math.max(...entries.map((e) => e.totalTokens));
    expect(peak).toBeLessThan(result.usage.totalTokens!);
  });

  it('single-turn multi-message-mock fixture stays a single entry equal to run totals (unchanged behavior)', async () => {
    assistantUsageSequenceOverride = [
      { input_tokens: 42, output_tokens: 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    ];

    const Runtime = await loadRuntime();
    const runtime = new Runtime();
    const result = await runtime.execute(makeInput());

    expect(result.usage.requestUsageEntries).toHaveLength(1);
    expect(result.usage.requestUsageEntries![0]).toEqual({
      inputTokens: 42,
      outputTokens: 7,
      cachedTokens: 0,
      totalTokens: 49,
    });
    expect(result.usage.inputTokens).toBe(42);
    expect(result.usage.outputTokens).toBe(7);
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
