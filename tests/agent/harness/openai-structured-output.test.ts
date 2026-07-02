/**
 * Tests for OpenAIAgentsHarness structured-output support:
 *   - toStrictJsonObjectSchema() converts an optional-fields schema into
 *     OpenAI's strict JsonObjectSchema shape (every field required,
 *     nullable types for the previously-optional ones), and rejects
 *     type-less property schemas it can't safely widen.
 *   - stripStrictNulls() removes null-valued keys the strict-mode dialect
 *     forces the model to emit for widened-optional fields.
 *   - execute() attaches outputType to the constructed Agent when
 *     outputSchema is passed, and populates structuredOutput on the result
 *     with strict-mode nulls stripped.
 *   - openScope() never threads outputSchema (map-phase must be unaffected).
 */

import { describe, expect, it } from 'bun:test';
import { Agent, Runner } from '@openai/agents';
import {
  OpenAIAgentsHarness,
  toStrictJsonObjectSchema,
  stripStrictNulls,
} from '@myco/agent/harness/openai.js';
import { ORCHESTRATOR_PLAN_JSON_SCHEMA } from '@myco/agent/orchestrator.js';

describe('toStrictJsonObjectSchema', () => {
  it('lists every property in required, including previously-optional ones', () => {
    const strict = toStrictJsonObjectSchema(ORCHESTRATOR_PLAN_JSON_SCHEMA as Record<string, unknown>);
    expect((strict as any).required.sort()).toEqual(['phases', 'reasoning'].sort());
    const itemsRequired = (strict as any).properties.phases.items.required;
    expect(itemsRequired.sort()).toEqual(['contextNotes', 'maxTurns', 'name', 'skip', 'skipReason'].sort());
  });

  it('makes previously-optional fields nullable', () => {
    const strict = toStrictJsonObjectSchema(ORCHESTRATOR_PLAN_JSON_SCHEMA as Record<string, unknown>);
    const props = (strict as any).properties.phases.items.properties;
    expect(props.skipReason.type).toEqual(['string', 'null']);
    expect(props.maxTurns.type).toEqual(['integer', 'null']);
    expect(props.contextNotes.type).toEqual(['string', 'null']);
    // Fields that were already required stay as-is.
    expect(props.name.type).toBe('string');
    expect(props.skip.type).toBe('boolean');
  });

  it('preserves additionalProperties: false at every object level', () => {
    const strict = toStrictJsonObjectSchema(ORCHESTRATOR_PLAN_JSON_SCHEMA as Record<string, unknown>);
    expect((strict as any).additionalProperties).toBe(false);
    expect((strict as any).properties.phases.items.additionalProperties).toBe(false);
  });

  it('throws when an optional property has no "type" key (enum/anyOf/$ref shapes)', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string' },
        tier: { enum: ['gold', 'silver', 'bronze'] },
      },
      required: ['name'],
      additionalProperties: false,
    };
    expect(() => toStrictJsonObjectSchema(schema)).toThrow(/tier/);
  });
});

describe('stripStrictNulls', () => {
  it('drops null-valued object entries but keeps non-null ones', () => {
    const input = { name: 'extract', skip: false, skipReason: null, maxTurns: null, contextNotes: null };
    expect(stripStrictNulls(input)).toEqual({ name: 'extract', skip: false });
  });

  it('recurses into nested objects and arrays', () => {
    const input = {
      phases: [
        { name: 'extract', skip: false, skipReason: null, maxTurns: null, contextNotes: null },
        { name: 'graph', skip: true, skipReason: 'done', maxTurns: 5, contextNotes: null },
      ],
      reasoning: 'ok',
    };
    expect(stripStrictNulls(input)).toEqual({
      phases: [
        { name: 'extract', skip: false },
        { name: 'graph', skip: true, skipReason: 'done', maxTurns: 5 },
      ],
      reasoning: 'ok',
    });
  });

  it('leaves non-object, non-null values untouched', () => {
    expect(stripStrictNulls('text')).toBe('text');
    expect(stripStrictNulls(42)).toBe(42);
    expect(stripStrictNulls(true)).toBe(true);
    expect(stripStrictNulls(null)).toBe(null);
  });
});

describe('OpenAIAgentsHarness.supports', () => {
  it('reports structuredOutput support', () => {
    const harness = new OpenAIAgentsHarness();
    expect(harness.supports('structuredOutput')).toBe(true);
  });
});

describe('OpenAIAgentsHarness structured output wiring', () => {
  it('attaches outputType to the constructed Agent when outputSchema is provided', async () => {
    let capturedAgent: Agent | undefined;
    const stubModelProvider = {
      async getModel() {
        return {
          async getResponse() {
            return {
              output: [{ type: 'output_text', text: '{"phases":[],"reasoning":"ok"}' }],
              usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
            };
          },
        };
      },
    } as any;
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider });
    const originalRun = (await import('@openai/agents')).Runner.prototype.run;
    (await import('@openai/agents')).Runner.prototype.run = async function (agent: Agent, ...rest: unknown[]) {
      capturedAgent = agent;
      return originalRun.apply(this, [agent, ...rest] as never);
    } as typeof originalRun;
    try {
      await harness.execute({
        prompt: 'plan the phases',
        model: 'gpt-5.4-mini',
        toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
        outputSchema: { name: 'orchestrator_plan', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      });
    } catch {
      // The stub model's raw output won't satisfy the full Runner
      // contract in every SDK version — this test only asserts on the
      // Agent construction, not on a successful run.
    } finally {
      (await import('@openai/agents')).Runner.prototype.run = originalRun;
    }
    expect(capturedAgent?.outputType).toEqual({
      type: 'json_schema',
      name: 'orchestrator_plan',
      strict: true,
      schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
    });
  });

  it('omits outputType when no outputSchema is provided', async () => {
    let capturedAgent: Agent | undefined;
    const stubModelProvider = {
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
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider });
    const originalRun = (await import('@openai/agents')).Runner.prototype.run;
    (await import('@openai/agents')).Runner.prototype.run = async function (agent: Agent, ...rest: unknown[]) {
      capturedAgent = agent;
      return originalRun.apply(this, [agent, ...rest] as never);
    } as typeof originalRun;
    try {
      await harness.execute({
        prompt: 'do something',
        model: 'gpt-5.4-mini',
        toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
      });
    } catch {
      // Same tolerance as above — only asserting on Agent construction.
    } finally {
      (await import('@openai/agents')).Runner.prototype.run = originalRun;
    }
    // The installed @openai/agents-core SDK defaults Agent.outputType to the
    // literal 'text' (see agent.js: `outputType = 'text'`), never `undefined`
    // — that's the SDK's own sentinel for "no structured output requested."
    expect(capturedAgent?.outputType).toBe('text');
  });

  it('openScope() never threads outputSchema onto the constructed Agent', async () => {
    let capturedAgent: Agent | undefined;
    const stubModelProvider = {
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
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider });
    const scope = await harness.openScope({
      model: 'gpt-5.4-mini',
      toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
    });
    const originalRun = (await import('@openai/agents')).Runner.prototype.run;
    (await import('@openai/agents')).Runner.prototype.run = async function (agent: Agent, ...rest: unknown[]) {
      capturedAgent = agent;
      return originalRun.apply(this, [agent, ...rest] as never);
    } as typeof originalRun;
    try {
      await scope.run({ prompt: 'item 1' });
    } catch {
      // Tolerate stub-model shape mismatches; only Agent construction matters here.
    } finally {
      (await import('@openai/agents')).Runner.prototype.run = originalRun;
      await scope.close();
    }
    // Same SDK default as above — 'text', not `undefined`.
    expect(capturedAgent?.outputType).toBe('text');
  });

  it('strips strict-mode null keys from structuredOutput on the schema\'d path', async () => {
    const stubModelProvider = {
      async getModel() {
        return { async getResponse() { throw new Error('unused — Runner.run is stubbed directly'); } };
      },
    } as any;
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider });
    const finalOutput = {
      phases: [{ name: 'extract', skip: false, skipReason: null, maxTurns: null, contextNotes: null }],
      reasoning: 'x',
    };
    const originalRun = Runner.prototype.run;
    Runner.prototype.run = (async function () {
      return {
        finalOutput,
        rawResponses: [{ usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 } }],
        lastResponseId: 'resp-1',
      };
    }) as typeof originalRun;
    let result;
    try {
      result = await harness.execute({
        prompt: 'plan the phases',
        model: 'gpt-5.4-mini',
        toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
        outputSchema: { name: 'orchestrator_plan', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      });
    } finally {
      Runner.prototype.run = originalRun;
    }
    expect(result.structuredOutput).toBeDefined();
    const directive = (result.structuredOutput as any).phases[0];
    expect(directive.name).toBe('extract');
    expect(directive.skip).toBe(false);
    expect('skipReason' in directive).toBe(false);
    expect('maxTurns' in directive).toBe(false);
    expect('contextNotes' in directive).toBe(false);
  });

  it('populates structuredOutput on the schema\'d path when no nulls are present', async () => {
    const stubModelProvider = {
      async getModel() {
        return { async getResponse() { throw new Error('unused — Runner.run is stubbed directly'); } };
      },
    } as any;
    const harness = new OpenAIAgentsHarness({ modelProvider: stubModelProvider });
    const finalOutput = {
      phases: [{ name: 'extract', skip: true, skipReason: 'nothing pending', maxTurns: 5, contextNotes: 'note' }],
      reasoning: 'done',
    };
    const originalRun = Runner.prototype.run;
    Runner.prototype.run = (async function () {
      return {
        finalOutput,
        rawResponses: [{ usage: { requests: 1, inputTokens: 10, outputTokens: 10, totalTokens: 20 } }],
        lastResponseId: 'resp-2',
      };
    }) as typeof originalRun;
    let result;
    try {
      result = await harness.execute({
        prompt: 'plan the phases',
        model: 'gpt-5.4-mini',
        toolSurface: { agentId: 'a', runId: 'r', toolNames: [] },
        outputSchema: { name: 'orchestrator_plan', schema: { type: 'object', properties: {}, required: [], additionalProperties: false } },
      });
    } finally {
      Runner.prototype.run = originalRun;
    }
    expect(result.structuredOutput).toEqual(finalOutput);
  });
});
