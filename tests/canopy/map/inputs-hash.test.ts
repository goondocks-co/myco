import { describe, it, expect } from 'bun:test';
import { computeInputsHash, MAP_TASK_PROMPT_VERSION } from '@myco/canopy/map/inputs-hash.js';

const baseInput = {
  canopyEntries: [
    { path: 'a.ts', content_hash: 'h1', llm_description: 'desc a' },
    { path: 'b.ts', content_hash: 'h2', llm_description: 'desc b' },
  ],
  rulesFiles: [
    { filename: 'AGENTS.md', content_hash: 'r1' },
    { filename: 'CLAUDE.md', content_hash: 'r2' },
  ],
  promptVersion: MAP_TASK_PROMPT_VERSION,
};

describe('computeInputsHash', () => {
  it('is stable across input ordering of canopy entries', () => {
    const h1 = computeInputsHash(baseInput);
    const reordered = { ...baseInput, canopyEntries: [...baseInput.canopyEntries].reverse() };
    expect(computeInputsHash(reordered)).toBe(h1);
  });

  it('changes when a canopy entry content_hash changes', () => {
    const h1 = computeInputsHash(baseInput);
    const mutated = {
      ...baseInput,
      canopyEntries: [{ ...baseInput.canopyEntries[0], content_hash: 'CHANGED' }, baseInput.canopyEntries[1]],
    };
    expect(computeInputsHash(mutated)).not.toBe(h1);
  });

  it('changes when an llm_description changes', () => {
    const h1 = computeInputsHash(baseInput);
    const mutated = {
      ...baseInput,
      canopyEntries: [{ ...baseInput.canopyEntries[0], llm_description: 'updated' }, baseInput.canopyEntries[1]],
    };
    expect(computeInputsHash(mutated)).not.toBe(h1);
  });

  it('changes when a rules file is added (listing-aware)', () => {
    const h1 = computeInputsHash(baseInput);
    const mutated = {
      ...baseInput,
      rulesFiles: [...baseInput.rulesFiles, { filename: '.cursor/rules/x.mdc', content_hash: 'n' }],
    };
    expect(computeInputsHash(mutated)).not.toBe(h1);
  });

  it('changes when prompt version is bumped', () => {
    const h1 = computeInputsHash(baseInput);
    const mutated = { ...baseInput, promptVersion: 'NEXT' };
    expect(computeInputsHash(mutated)).not.toBe(h1);
  });
});
