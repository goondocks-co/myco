/**
 * Tests for extractPartialRawResponses's MaxTurnsExceededError rescue path
 * (gotcha-82ccd461): `AgentsError.state` (thrown by e.g.
 * MaxTurnsExceededError, agents-core turnPreparation.js) is a bare
 * `RunState`, not a `RunResult`. `RunResult.rawResponses` is a getter that
 * reads `this.state._modelResponses` (agents-core result.js), but
 * `RunState` itself only exposes `_modelResponses` directly — it has no
 * `rawResponses` getter of its own. Before this fix, extractPartialRawResponses
 * probed `err.state?.rawResponses` (always undefined on a RunState) and
 * every MaxTurnsExceededError rescue silently returned {} usage, so a
 * failed run that had already burned real, billed turns recorded
 * tokens_used=0.
 */

import { describe, expect, it } from 'bun:test';
import { OpenAIAgentsHarness } from '@myco/agent/harness/openai.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';

// A model stub whose getResponse() always returns a non-empty, billed turn
// but never produces a final text output — the Runner keeps calling it
// every turn until state._maxTurns binds and turnPreparation.js throws
// MaxTurnsExceededError(message, state). Each turn's usage lands on
// state._modelResponses via state._lastTurnResponse (run.js ~455/479),
// mirroring how a real provider call accumulates usage before a max-turns
// failure — not the OpenRouter 200-wrapped-failure shape (that's covered by
// openai-responses-failure-detection.test.ts and Fix 1's fetch-seam guard;
// this test is specifically about the SDK's own max-turns error carrying
// real usage that the harness must not lose on rescue).
function loopingToolCallModelProvider(perTurnTokens: number) {
  return {
    async getModel() {
      return {
        async getResponse() {
          return {
            output: [
              {
                type: 'function_call',
                callId: 'call_1',
                name: 'noop_tool',
                arguments: '{}',
                status: 'completed',
              },
            ],
            usage: {
              requests: 1,
              inputTokens: perTurnTokens,
              outputTokens: perTurnTokens,
              totalTokens: perTurnTokens * 2,
              // agents-core ≥0.14 tracing snapshots reduce over these arrays
              // unguarded (runner/tracing.js sumUsageDetail); the SDK's own
              // Usage class always normalizes them to [], so a Model
              // implementation's response usage must carry them too.
              inputTokensDetails: [],
              outputTokensDetails: [],
            },
          };
        },
      };
    },
  } as any;
}

describe('OpenAIAgentsHarness.execute — MaxTurnsExceededError usage rescue', () => {
  it('records non-zero usage when the run hits maxTurns via a tool-call loop', async () => {
    const harness = new OpenAIAgentsHarness({ modelProvider: loopingToolCallModelProvider(100) });

    let caught: unknown;
    try {
      await harness.execute({
        prompt: 'do something',
        model: 'gpt-5.4-mini',
        provider: { type: 'openai' },
        maxTurns: 3,
        toolSurface: {
          agentId: 'a',
          runId: 'r',
          tools: [{
            name: 'noop_tool',
            description: 'does nothing',
            parameters: { type: 'object', properties: {}, additionalProperties: false },
            handler: async () => 'ok',
          }] as any,
        },
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(HarnessExecutionError);
    const harnessErr = caught as InstanceType<typeof HarnessExecutionError>;
    expect(harnessErr.telemetry.kind).toBe('max-turns');
    // The bug: before the fix this was 0 (extractPartialRawResponses found
    // nothing on state.rawResponses, which doesn't exist on a RunState).
    expect(harnessErr.telemetry.usage.totalTokens ?? 0).toBeGreaterThan(0);
    expect(harnessErr.telemetry.usage.requests ?? 0).toBeGreaterThan(0);
  });
});
