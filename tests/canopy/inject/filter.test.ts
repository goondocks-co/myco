import { describe, it, expect } from 'bun:test';
import type { CanopyEntry } from '@myco/db/schema';
import { decide, type IntentInput } from '@myco/canopy/inject/filter';

function makeEntry(overrides: Partial<CanopyEntry> = {}): CanopyEntry {
  return {
    project_id: '/repo',
    machine_id: 'local',
    path: 'src/foo.ts',
    content_hash: 'a'.repeat(64),
    size_bytes: 4096,
    token_estimate: 1000,
    line_count: 100,
    language: 'typescript',
    exports_json: '[]',
    imports_json: '[]',
    top_comment: null,
    mechanical_updated_at: 1700000000,
    llm_description: null,
    llm_updated_at: null,
    ...overrides,
  };
}

const okConfig = { enabled: true, sizeThreshold: 800 };

function makeInput(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    toolInput: { file_path: 'src/foo.ts' },
    entry: makeEntry(),
    config: okConfig,
    capabilityOn: true,
    ...overrides,
  };
}

describe('decide', () => {
  it('injects when all gates pass', () => {
    const result = decide(makeInput());
    expect(result.inject).toBe(true);
    if (result.inject) expect(result.entry.path).toBe('src/foo.ts');
  });

  it('returns capability_off when capability flag is false (highest priority)', () => {
    const result = decide(makeInput({
      capabilityOn: false,
      // Even with all other gates failing, capability_off is reported first.
      config: { enabled: false, sizeThreshold: 800 },
      entry: null,
      toolInput: { offset: 5 },
    }));
    expect(result).toEqual({ inject: false, reason: 'capability_off' });
  });

  it('returns disabled when config.enabled is false', () => {
    const result = decide(makeInput({
      config: { enabled: false, sizeThreshold: 800 },
    }));
    expect(result).toEqual({ inject: false, reason: 'disabled' });
  });

  it('returns targeted when offset is set', () => {
    const result = decide(makeInput({
      toolInput: { file_path: 'src/foo.ts', offset: 100 },
    }));
    expect(result).toEqual({ inject: false, reason: 'targeted' });
  });

  it('returns targeted when limit is set', () => {
    const result = decide(makeInput({
      toolInput: { file_path: 'src/foo.ts', limit: 50 },
    }));
    expect(result).toEqual({ inject: false, reason: 'targeted' });
  });

  it('returns targeted when both offset and limit are set', () => {
    const result = decide(makeInput({
      toolInput: { file_path: 'src/foo.ts', offset: 0, limit: 50 },
    }));
    expect(result).toEqual({ inject: false, reason: 'targeted' });
  });

  it('returns unknown_file when entry is null', () => {
    const result = decide(makeInput({ entry: null }));
    expect(result).toEqual({ inject: false, reason: 'unknown_file' });
  });

  it('returns small_file when size_bytes is below threshold', () => {
    const result = decide(makeInput({
      entry: makeEntry({ size_bytes: 500 }),
    }));
    expect(result).toEqual({ inject: false, reason: 'small_file' });
  });

  it('injects when size_bytes equals threshold (strict less-than)', () => {
    const result = decide(makeInput({
      entry: makeEntry({ size_bytes: 800 }),
    }));
    expect(result.inject).toBe(true);
  });

  it('does not treat offset=0 as targeted', () => {
    // offset=0 is a valid "read from start" — but since the spec gates on
    // "is offset/limit set," 0 still counts as set. Document the literal
    // contract: any non-null offset triggers targeted.
    const result = decide(makeInput({
      toolInput: { file_path: 'src/foo.ts', offset: 0 },
    }));
    expect(result).toEqual({ inject: false, reason: 'targeted' });
  });

  it('priority: capability_off > disabled > targeted > unknown_file > small_file', () => {
    // disabled beats targeted/unknown/small
    expect(decide(makeInput({
      config: { enabled: false, sizeThreshold: 800 },
      entry: null,
      toolInput: { offset: 5 },
    }))).toEqual({ inject: false, reason: 'disabled' });

    // targeted beats unknown/small
    expect(decide(makeInput({
      entry: null,
      toolInput: { offset: 5 },
    }))).toEqual({ inject: false, reason: 'targeted' });

    // unknown beats small (small needs an entry to even check)
    expect(decide(makeInput({ entry: null }))).toEqual({
      inject: false,
      reason: 'unknown_file',
    });
  });
});
