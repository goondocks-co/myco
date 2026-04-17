/**
 * Unit tests for `buildMatrixPayload` + `computeCellCount` — the pure
 * helpers backing `MatrixRunDialog` in the Comparisons tab. The dialog
 * itself has no React-Testing-Library harness; these helper tests are the
 * coverage bar for matrix-payload construction.
 *
 * Parallels `execution-overrides.test.ts` in style and strictness.
 */

import { describe, expect, it } from 'vitest';
import {
  buildMatrixPayload,
  computeCellCount,
  mapPhasesToWire,
  type MatrixFormState,
} from '../../packages/myco/ui/src/components/agent/matrix-dialog-form';
import type { ProviderConfig } from '../../packages/myco/ui/src/hooks/use-providers';

function emptyMatrix(over: Partial<MatrixFormState> = {}): MatrixFormState {
  return {
    runtimes: [],
    reasoningLevels: [],
    models: [],
    dryRun: false,
    phases: {},
    ...over,
  };
}

describe('computeCellCount', () => {
  it('returns 1 when every dimension is empty (task-defaults cell)', () => {
    expect(computeCellCount({ runtimes: [], reasoningLevels: [], models: [] })).toBe(1);
  });

  it('multiplies 2 runtimes × 3 reasoning × 0 models = 6', () => {
    expect(
      computeCellCount({
        runtimes: ['a', 'b'],
        reasoningLevels: ['low', 'default', 'high'],
        models: [],
      }),
    ).toBe(6);
  });

  it('multiplies 0 runtimes × 2 reasoning × 2 models = 4', () => {
    expect(
      computeCellCount({
        runtimes: [],
        reasoningLevels: ['default', 'high'],
        models: ['m1', 'm2'],
      }),
    ).toBe(4);
  });

  it('multiplies 2 × 3 × 2 = 12', () => {
    expect(
      computeCellCount({
        runtimes: ['a', 'b'],
        reasoningLevels: ['low', 'default', 'high'],
        models: ['m1', 'm2'],
      }),
    ).toBe(12);
  });
});

describe('buildMatrixPayload', () => {
  it('returns an empty object when every dimension is empty (task-defaults cell)', () => {
    expect(buildMatrixPayload(emptyMatrix())).toEqual({});
  });

  it('includes runtimes only when non-empty', () => {
    expect(
      buildMatrixPayload(emptyMatrix({ runtimes: ['claude-sdk', 'openai-agents'] })),
    ).toEqual({
      runtimes: ['claude-sdk', 'openai-agents'],
    });
  });

  it('includes reasoningLevels only when non-empty', () => {
    expect(
      buildMatrixPayload(emptyMatrix({ reasoningLevels: ['low', 'high'] })),
    ).toEqual({
      reasoningLevels: ['low', 'high'],
    });
  });

  it('includes models only when non-empty', () => {
    expect(
      buildMatrixPayload(emptyMatrix({ models: ['claude-sonnet-4-5'] })),
    ).toEqual({
      models: ['claude-sonnet-4-5'],
    });
  });

  it('strips whitespace and drops empty-string model entries', () => {
    expect(
      buildMatrixPayload(
        emptyMatrix({ models: ['  claude-sonnet-4-5  ', '', '   '] }),
      ),
    ).toEqual({
      models: ['claude-sonnet-4-5'],
    });
  });

  it('omits the models key entirely when every entry is blank', () => {
    expect(
      buildMatrixPayload(emptyMatrix({ models: ['', '   '] })),
    ).toEqual({});
  });

  it('includes dryRun only when true', () => {
    expect(buildMatrixPayload(emptyMatrix({ dryRun: true }))).toEqual({ dryRun: true });
  });

  it('includes notes only when non-empty after trimming', () => {
    expect(
      buildMatrixPayload(emptyMatrix({ notes: '  why not  ' })),
    ).toEqual({ notes: 'why not' });
  });

  it('drops empty / whitespace-only notes', () => {
    expect(buildMatrixPayload(emptyMatrix({ notes: '   ' }))).toEqual({});
  });

  it('combines every dimension into one payload', () => {
    expect(
      buildMatrixPayload(emptyMatrix({
        runtimes: ['claude-sdk'],
        reasoningLevels: ['default', 'high'],
        models: ['claude-sonnet-4-5'],
        dryRun: true,
      })),
    ).toEqual({
      runtimes: ['claude-sdk'],
      reasoningLevels: ['default', 'high'],
      models: ['claude-sonnet-4-5'],
      dryRun: true,
    });
  });

  it('emits phase overrides converted to wire shape', () => {
    const ollama: ProviderConfig = {
      runtime: 'claude-sdk',
      type: 'ollama',
      base_url: 'http://localhost:11434',
      model: 'qwen3:30b',
    };
    const out = buildMatrixPayload(
      emptyMatrix({
        runtimes: ['claude-sdk'],
        phases: {
          extract: { reasoningLevel: 'high', maxTurns: 25, provider: ollama },
        },
      }),
    );
    expect(out.runtimes).toEqual(['claude-sdk']);
    expect(out.phases).toEqual({
      extract: {
        reasoningLevel: 'high',
        maxTurns: 25,
        provider: {
          type: 'ollama',
          runtime: 'claude-sdk',
          baseUrl: 'http://localhost:11434',
          model: 'qwen3:30b',
        },
      },
    });
  });

  it('drops phase entries that carry no actual overrides', () => {
    const out = buildMatrixPayload(
      emptyMatrix({
        phases: {
          extract: {}, // empty entry — should drop
          synthesize: { model: 'claude-haiku-4-5' },
        },
      }),
    );
    expect(out.phases).toEqual({
      synthesize: { model: 'claude-haiku-4-5' },
    });
  });

  it('trims whitespace on per-phase model entries', () => {
    const out = buildMatrixPayload(
      emptyMatrix({
        phases: {
          extract: { model: '  custom-model  ' },
        },
      }),
    );
    expect(out.phases).toEqual({
      extract: { model: 'custom-model' },
    });
  });

  it('omits phases key when every phase entry drops', () => {
    const out = buildMatrixPayload(
      emptyMatrix({
        phases: {
          extract: {}, // empty
          synthesize: { model: '   ' }, // whitespace-only — drops
        },
      }),
    );
    expect(out).toEqual({});
  });
});

describe('mapPhasesToWire', () => {
  it('returns undefined when no phase entry carries any override', () => {
    expect(mapPhasesToWire({})).toBeUndefined();
    expect(mapPhasesToWire({ extract: {} })).toBeUndefined();
  });

  it('keeps only the fields that are set', () => {
    const out = mapPhasesToWire({
      extract: { reasoningLevel: 'low' },
      synthesize: { maxTurns: 10 },
    });
    expect(out).toEqual({
      extract: { reasoningLevel: 'low' },
      synthesize: { maxTurns: 10 },
    });
  });
});
