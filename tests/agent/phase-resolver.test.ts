/**
 * Tests for resolvePhaseExecution — the layered precedence chain that
 * decides which `reasoningLevel / model / maxTurns / provider` a phase
 * actually uses. Especially focused on the reasoningLevel chain since
 * grove.yaml-layer overrides were added late and the silent precedence
 * bug there (model override shadowing tier) is what these tests guard.
 */

import { describe, it, expect } from 'bun:test';
import { resolvePhaseExecution } from '@myco/agent/phase-resolver.js';
import type { MycoYamlPhaseOverrides } from '@myco/agent/phase-resolver.js';
import type {
  EffectiveConfig,
  PhaseDefinition,
  ProviderConfig,
  RunOptions,
} from '@myco/agent/types.js';

function makePhase(overrides: Partial<PhaseDefinition> = {}): PhaseDefinition {
  return {
    name: 'p',
    prompt: 'x',
    tools: [],
    maxTurns: 10,
    required: false,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
  return {
    taskName: 't',
    taskDisplayName: 'T',
    taskPrompt: 'p',
    systemPromptPath: 'system.md',
    harness: 'claude-sdk',
    model: 'sonnet',
    maxTurns: 100,
    timeoutSeconds: 600,
    tools: [],
    ...overrides,
  } as EffectiveConfig;
}

const SONNET_MAP_PROVIDER: ProviderConfig = {
  type: 'anthropic',
  model: 'sonnet',
  reasoningMap: { low: 'haiku', default: 'sonnet', high: 'opus' },
};

describe('resolvePhaseExecution — reasoning level chain', () => {
  it('uses phase.reasoningLevel from the task YAML when nothing overrides', () => {
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'low' }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
    );
    expect(result.reasoningLevel).toBe('low');
    expect(result.model).toBe('haiku');
  });

  it('grove.yaml override outranks the YAML default (low → default)', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'default' },
    };
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'low' }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('default');
    expect(result.model).toBe('sonnet');
  });

  it('grove.yaml override can also widen to high', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'high' },
    };
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'low' }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('high');
    expect(result.model).toBe('opus');
  });

  it('grove.yaml override applies even when YAML phase has no reasoningLevel', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'low' },
    };
    const result = resolvePhaseExecution(
      makePhase({ /* no reasoningLevel */ }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('low');
    expect(result.model).toBe('haiku');
  });

  it('runtime executionOverrides outranks grove.yaml override', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'high' },
    };
    const options: RunOptions = {
      executionOverrides: {
        phases: { p: { reasoningLevel: 'low' } },
      },
    } as RunOptions;
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'default' }),
      options,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('low');
  });

  it('grove.yaml-layer overrides apply only to the named phase', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      'other-phase': { reasoningLevel: 'high' },
    };
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'low' }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    // Unaffected — override was keyed to a different phase
    expect(result.reasoningLevel).toBe('low');
  });

  it('an explicit grove.yaml model: override pins the model even when reasoningLevel is set', () => {
    // This is the "escape hatch" — a model override pins the SKU regardless
    // of the resolved tier. Used for narrow A/B experiments.
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'low', model: 'claude-haiku-4-5-20251001' },
    };
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'default' }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('low');
    expect(result.model).toBe('claude-haiku-4-5-20251001');
  });

  it('maxTurns and reasoningLevel overrides are independent', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { reasoningLevel: 'default', maxTurns: 25 },
    };
    const result = resolvePhaseExecution(
      makePhase({ reasoningLevel: 'low', maxTurns: 10 }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.reasoningLevel).toBe('default');
    expect(result.maxTurns).toBe(25);
  });
});

describe('resolvePhaseExecution — maxTurns chain (regression guard)', () => {
  it('grove.yaml-layer maxTurns outranks YAML default', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { maxTurns: 50 },
    };
    const result = resolvePhaseExecution(
      makePhase({ maxTurns: 10 }),
      undefined,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.maxTurns).toBe(50);
  });

  it('runtime maxTurns outranks grove.yaml-layer', () => {
    const yamlOverrides: MycoYamlPhaseOverrides = {
      p: { maxTurns: 50 },
    };
    const options: RunOptions = {
      executionOverrides: { phases: { p: { maxTurns: 100 } } },
    } as RunOptions;
    const result = resolvePhaseExecution(
      makePhase({ maxTurns: 10 }),
      options,
      makeConfig(),
      SONNET_MAP_PROVIDER,
      yamlOverrides,
    );
    expect(result.maxTurns).toBe(100);
  });
});
