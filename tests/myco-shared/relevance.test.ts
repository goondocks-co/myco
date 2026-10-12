import { describe, expect, it } from 'bun:test';
import { mutualProximity, selectRelevantSpores, type SporeCandidate } from '../../packages/myco-shared/src/relevance.js';

const background = (n = 30): SporeCandidate[] => Array.from({ length: n }, (_, i) => ({
  id: `background-${i}`, similarity: 0.1 + i / 1000, neighborMean: 0.5, neighborStd: 0.1,
}));

describe('prompt relevance', () => {
  it('withholds an uncalibrated pool and uses two-sided corpus evidence for new spores', () => {
    const fresh = { id: 'new', similarity: 0.3 };
    expect(mutualProximity(0.7, { mean: 0.9, std: 0.1 })).toBe(0);
    expect(selectRelevantSpores([fresh, { id: 'other', similarity: 0.1 }], { maxResults: 7 })).toEqual([]);
    expect(selectRelevantSpores([fresh, ...background()], { maxResults: 7 })).toEqual([]);
    expect(selectRelevantSpores([{ ...fresh, similarity: 0.9 }, ...background()], { maxResults: 7 }).map(s => s.id)).toEqual(['new']);
  });

  it('bounds an isolated baseline while preserving hub suppression and a genuinely close outlier', () => {
    const outlier = { id: 'outlier', similarity: 0.3, neighborMean: 0.95, neighborStd: 0.02 };
    expect(selectRelevantSpores([outlier, ...background()], { maxResults: 7 })).toEqual([]);
    for (const size of [1, 2, 3, 4]) {
      expect(selectRelevantSpores([outlier, ...background(size)], { maxResults: 7 })).toEqual([]);
    }
    expect(selectRelevantSpores([{ ...outlier, similarity: 0.95 }, ...background()], { maxResults: 7 }).map(s => s.id)).toEqual(['outlier']);
    expect(selectRelevantSpores([{ id: 'hub', similarity: 0.6, neighborMean: 0.2, neighborStd: 0.1 }, ...background()], { maxResults: 7 })).toEqual([]);
  });

  it('separates weaker semantic matches when both probability factors saturate', () => {
    const reference = Array.from({ length: 30 }, (_, i) => ({
      id: `far-${i}`, similarity: -0.5, neighborMean: 1.5, neighborStd: 0.01,
    }));
    const selected = selectRelevantSpores([
      { id: 'exact', similarity: 1 }, { id: 'weak', similarity: 0 }, ...reference,
    ], { maxResults: 7 });
    expect(selected.map(s => s.id)).toEqual(['exact']);
  });

  it('keeps the calibration background stable as served items leave the eligible pool', () => {
    const pool = [{ id: 'a', similarity: 0.9, neighborMean: 0.5, neighborStd: 0.1 }, ...background()];
    const first = selectRelevantSpores(pool, { maxResults: 7 });
    const excluded = selectRelevantSpores(pool.map(c => ({ ...c, alreadyInjected: c.id === 'background-0' })), { maxResults: 7 });
    expect(excluded).toEqual(first);
  });
});
