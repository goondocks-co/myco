/**
 * Tests for OpenAIAgentsHarness modelSettings wiring:
 *   - execute() resolves reasoningLevel + provider into ModelSettings via
 *     resolveModelSettings() and attaches it to the constructed Agent, but
 *     ONLY when the resolved model name is GPT-5-family
 *     (`gpt5ReasoningSettingsRequired`, from @openai/agents-core's
 *     defaultModel.js, re-exported via '@openai/agents').
 *   - openScope() gets the same treatment — setup.reasoningLevel flows
 *     through prepareOpenAIRun exactly like setup.model/provider already do
 *     (mirrors the Claude harness, where thinking-config resolution applies
 *     to both execute() and openScope(), not just execute()).
 *   - Local providers (ollama/lmstudio/openai-compatible) never get a
 *     `modelSettings` key passed to the Agent constructor at all — the SDK's
 *     own default (`{}` for non-GPT-5 model names) is what the Agent ends up
 *     with, identical to today's behavior before this wiring existed.
 *   - Non-local providers with a non-GPT-5 model name (gpt-4.1-mini, an
 *     arbitrary openrouter route) ALSO get no `modelSettings` key — passing
 *     it explicitly would bypass agents-core's own guard (agent.js ~96-116)
 *     that resets settings to `{}` for those models, and the API 400s on
 *     `reasoning.effort`/`text.verbosity` for a model that doesn't support it.
 */

import { describe, expect, it, mock } from 'bun:test';
import { Agent, Runner } from '@openai/agents';
import { OpenAIAgentsHarness } from '@myco/agent/harness/openai.js';

// The real ensure path makes network calls (loaded-state query + load)
// before the harness can construct the Agent. Stub it so the lmstudio
// local-provider case can be asserted at the harness level without
// depending on a live LM Studio server — mirrors how
// runtime-claude.test.ts stubs SDK-adjacent modules rather than hitting
// the real thing.
mock.module('@myco/intelligence/lmstudio-instances.js', () => ({
  ensureLmStudioModelInstance: async () => ({ instanceId: 'stub-lmstudio-model', loaded: true }),
}));

function stubModelProvider() {
  return {
    async getModel() {
      return {
        async getResponse() {
          return {
            output: [{ type: 'output_text', text: 'plain text response' }],
            usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
          };
        },
      };
    },
  } as any;
}

async function captureConstructedAgent(run: () => Promise<unknown>): Promise<Agent | undefined> {
  let capturedAgent: Agent | undefined;
  const originalRun = Runner.prototype.run;
  Runner.prototype.run = async function (agent: Agent, ...rest: unknown[]) {
    capturedAgent = agent;
    return originalRun.apply(this, [agent, ...rest] as never);
  } as typeof originalRun;
  try {
    await run();
  } catch {
    // Tolerate stub-model shape mismatches; only Agent construction matters here.
  } finally {
    Runner.prototype.run = originalRun;
  }
  return capturedAgent;
}

describe('OpenAIAgentsHarness.execute — modelSettings wiring', () => {
  it('attaches modelSettings resolved from reasoningLevel + provider for a non-local provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-5.4-mini',
      provider: { type: 'openai' },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'high' },
      text: { verbosity: 'high' },
    });
  });

  it('defaults to the medium tier when reasoningLevel is omitted for a non-local provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-5.4-mini',
      provider: { type: 'openai' },
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' },
    });
  });

  it('defaults to the medium tier when no provider is supplied at all', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-5.4-mini',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'medium' },
      text: { verbosity: 'medium' },
    });
  });

  it('honors a provider effortMap override for a non-local provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-5.4-mini',
      provider: {
        type: 'openai',
        effortMap: { low: { effort: 'minimal', verbosity: 'low' } },
      },
      reasoningLevel: 'low',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'minimal' },
      text: { verbosity: 'low' },
    });
  });

  it('resolves the same way for an openrouter provider routing to a GPT-5-family model', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-5.4-mini',
      provider: { type: 'openrouter' },
      reasoningLevel: 'low',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'low' },
      text: { verbosity: 'low' },
    });
  });

  it('sends no modelSettings key for a non-GPT-5 model name even on a non-local provider (gpt-4.1-mini)', async () => {
    // Structural regression guard: explicitly passing `modelSettings` to
    // `new Agent(...)` bypasses agents-core's own guard (agent.js ~96-116)
    // that resets settings to `{}` for non-GPT-5 model names. A configured
    // effortMap + a non-default reasoningLevel must NOT be enough to force
    // reasoning/text fields onto a model the SDK doesn't recognize as
    // GPT-5-family — the OpenAI API 400s on `reasoning.effort` for models
    // like gpt-4.1-mini that don't support it.
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gpt-4.1-mini',
      provider: {
        type: 'openai',
        effortMap: { high: { effort: 'xhigh', verbosity: 'high' } },
      },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });

  it('sends no modelSettings key for an arbitrary (non-GPT-5) openrouter route', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'openrouter/auto',
      provider: { type: 'openrouter' },
      reasoningLevel: 'low',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });

  // OpenRouter catalogs GPT-5-family models under vendor-prefixed slugs
  // ('openai/gpt-5.4-mini'). The SDK's own gpt5ReasoningSettingsRequired does
  // a plain startsWith('gpt-5') check, which fails on the vendor prefix — so
  // prepareOpenAIRun strips everything through the first '/' before running
  // the classification (stripVendorPrefix in openai.ts). The ACTUAL request
  // still sends the full "openai/gpt-5.4-mini" slug; only the classification
  // input is normalized.
  it('openrouter vendor-prefixed GPT-5 slugs get modelSettings attached (vendor-prefix normalized before the gpt5 check)', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'openai/gpt-5.4-mini',
      provider: {
        type: 'openrouter',
        effortMap: { high: { effort: 'xhigh', verbosity: 'high' } },
      },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'xhigh' },
      text: { verbosity: 'high' },
    });
    // The full vendor-prefixed slug is still what's sent as the model —
    // normalization applies ONLY to the gpt5ReasoningSettingsRequired check.
    expect(capturedAgent?.model).toBe('openai/gpt-5.4-mini');
  });

  it('vendor-prefixed NON-GPT-5 openrouter slugs still get no modelSettings after stripping the prefix', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'openai/gpt-4o-mini',
      provider: {
        type: 'openrouter',
        effortMap: { high: { effort: 'xhigh', verbosity: 'high' } },
      },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });

  it('sends no modelSettings key to the Agent constructor for an ollama provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gemma4:26b',
      provider: { type: 'ollama' },
      reasoningLevel: 'low',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    // The SDK's own default for a non-GPT-5 model name is `{}` — proof that
    // no `modelSettings` key was passed to `new Agent({...})` at all, byte-
    // for-byte identical to pre-wiring behavior.
    expect(capturedAgent?.modelSettings).toEqual({});
  });

  it('sends no modelSettings key to the Agent constructor for a lmstudio provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'local-model',
      provider: { type: 'lmstudio' },
      reasoningLevel: 'default',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });

  it('sends no modelSettings key to the Agent constructor for an openai-compatible provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'google/gemma-4-26b-a4b',
      provider: { type: 'openai-compatible' },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });

  it('ADVERSARIAL: an aggressively configured local provider (effortMap high + reasoningLevel high) still sends nothing', async () => {
    // Regression guard for the plan's global constraint: local providers
    // (ollama/lmstudio/openai-compatible) must see ZERO reasoning/text
    // fields sent, no matter how the operator has configured effortMap or
    // reasoningLevel. resolveModelSettings() already enforces this via
    // isLocalProvider() — this test locks the harness call site so a
    // future refactor of prepareOpenAIRun can't silently start spreading
    // in a value for local providers.
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const capturedAgent = await captureConstructedAgent(() => harness.execute({
      prompt: 'do something',
      model: 'gemma4:26b',
      provider: {
        type: 'ollama',
        effortMap: { high: { effort: 'xhigh', verbosity: 'high' } },
      },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    }));

    expect(capturedAgent?.modelSettings).toEqual({});
  });
});

describe('OpenAIAgentsHarness.openScope — modelSettings wiring', () => {
  it('attaches modelSettings resolved from setup.reasoningLevel + setup.provider', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const scope = await harness.openScope({
      model: 'gpt-5.4-mini',
      provider: { type: 'openai' },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    });
    const capturedAgent = await captureConstructedAgent(() => scope.run({ prompt: 'item 1' }));
    await scope.close();

    expect(capturedAgent?.modelSettings).toEqual({
      reasoning: { effort: 'high' },
      text: { verbosity: 'high' },
    });
  });

  it('sends no modelSettings key to the Agent constructor for a local provider scope', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider() });
    const scope = await harness.openScope({
      model: 'gemma4:26b',
      provider: { type: 'ollama' },
      reasoningLevel: 'high',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    });
    const capturedAgent = await captureConstructedAgent(() => scope.run({ prompt: 'item 1' }));
    await scope.close();

    expect(capturedAgent?.modelSettings).toEqual({});
  });
});
