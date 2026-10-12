import { describe, expect, it } from 'bun:test';
import { mutualProximity, selectRelevantPlans, selectRelevantSpores, type SporeCandidate } from '../../packages/myco-shared/src/relevance.js';

const background = (n = 30): SporeCandidate[] => Array.from({ length: n }, (_, i) => ({
  id: `background-${i}`, similarity: 0.1 + i / 1000, neighborMean: 0.5, neighborStd: 0.1,
}));

describe('prompt relevance', () => {
  it('leaves the outlier out of its own query statistics so it cannot widen the spore band', () => {
    const candidates = [0.9, 0.77, 0.3, 0.32, 0.35, 0.39].map((similarity, i) => ({
      id: i === 0 ? 'outlier' : i === 1 ? 'runner-up' : `peer-${i}`,
      similarity, neighborMean: 0.7, neighborStd: 0.06,
    }));
    expect(selectRelevantSpores(candidates, { maxResults: 7 }).map(c => c.id)).toEqual(['outlier']);
  });

  it('withholds spores with fewer than five calibrated reference candidates', () => {
    const fresh = { id: 'new', similarity: 0.9 };
    for (const size of [0, 1, 2, 3, 4]) {
      let counts: unknown;
      expect(selectRelevantSpores([fresh, ...background(size)], { maxResults: 7, observe: n => { counts = n; } })).toEqual([]);
      expect(counts).toEqual({ calibrated: size, scored: 0, probable: 0, separated: 0 });
    }
    expect(selectRelevantSpores([fresh, ...background(5)], { maxResults: 7 }).map(c => c.id)).toEqual(['new']);
  });

  it('distinguishes missing calibration from a fully excluded calibrated pool', () => {
    const counts: unknown[] = [];
    selectRelevantSpores([{ id: 'new', similarity: 0.8 }], { maxResults: 7, observe: n => counts.push(n) });
    selectRelevantSpores(background().map(c => ({ ...c, alreadyInjected: true })), { maxResults: 7, observe: n => counts.push(n) });
    expect(counts).toEqual([
      { calibrated: 0, scored: 0, probable: 0, separated: 0 },
      { calibrated: 30, scored: 0, probable: 0, separated: 0 },
    ]);
  });

  it.each([1, 2, 4])('withholds a pool of %s calibrated live plans as insufficient', size => {
    let stage: unknown;
    const candidates = Array.from({ length: size }, (_, i) => ({ id: 'plan-' + i, similarity: 0.95 - i / 100, neighborMean: 0.3, neighborStd: 0.06 }));
    expect(selectRelevantPlans(candidates, { maxResults: 2, sporeCandidates: background(), observeCalibration: s => { stage = s; } })).toEqual([]);
    expect(stage).toBe('insufficient');
  });

  it.each([0, 1, 4])('withholds an adequate plan pool with only %s independent spores', size => {
    let stage: unknown;
    const plans = Array.from({ length: 8 }, (_, i) => ({
      id: 'plan-' + i, similarity: 0.53 - i / 100, neighborMean: 0.3, neighborStd: 0.06,
    }));
    expect(selectRelevantPlans(plans, { maxResults: 2, sporeCandidates: background(size),
      observeCalibration: s => { stage = s; } })).toEqual([]);
    expect(stage).toBe('insufficient');
  });

  it('withholds a flat adequate-size live pool as insufficient', () => {
    let stage: unknown;
    const candidates = Array.from({ length: 5 }, (_, i) => ({ id: 'plan-' + i, similarity: 0.95 - i / 100, neighborMean: 0.3, neighborStd: 0 }));
    expect(selectRelevantPlans(candidates, { maxResults: 2, sporeCandidates: background(), observeCalibration: s => { stage = s; } })).toEqual([]);
    expect(stage).toBe('insufficient');
  });

  it('admits a live transcript plan against its own model baseline and rejects an ordinary match', () => {
    const candidate = { id: 'preserve-pending-transcript-batches', similarity: 0.53, neighborMean: 0.3, neighborStd: 0.06 };
    const sporeCandidates = Array.from({ length: 30 }, (_, i) => ({ id: 'other-' + i, similarity: 0.4 + i / 1000 }));
    const referenceCandidates = Array.from({ length: 5 }, (_, i) => ({ ...candidate, id: `peer-${i}` }));
    expect(selectRelevantPlans([candidate], { maxResults: 2, sporeCandidates, referenceCandidates }).map(c => c.id)).toEqual([candidate.id]);
    expect(selectRelevantPlans([{ ...candidate, similarity: 0.2 }], { maxResults: 2, sporeCandidates, referenceCandidates })).toEqual([]);
  });

  it('withholds a plan missing its own statistics even with an adequate calibration pool', () => {
    const referenceCandidates = Array.from({ length: 5 }, (_, i) => ({ id: 'peer-' + i, similarity: 0.4, neighborMean: 0.3, neighborStd: 0.06 }));
    expect(selectRelevantPlans([{ id: 'unproven', similarity: 0.95 }], { maxResults: 2, referenceCandidates, sporeCandidates: background() })).toEqual([]);
  });

  it('separates weaker plans after the probability floor', () => {
    let counts: unknown;
    const candidates = [{ id: 'strong', similarity: 0.9, neighborMean: 0.5, neighborStd: 0.1 }, { id: 'weak', similarity: 0.55, neighborMean: 0.5, neighborStd: 0.1 }];
    const sporeCandidates = Array.from({ length: 12 }, (_, i) => ({ id: 'other-' + i, similarity: -0.3 + i * 0.09 }));
    const referenceCandidates = Array.from({ length: 5 }, (_, i) => ({ id: 'plan-' + i, similarity: 0.1, neighborMean: 0.5, neighborStd: 0.1 }));
    expect(selectRelevantPlans(candidates, { maxResults: 2, sporeCandidates, referenceCandidates, observe: n => { counts = n; } }).map(c => c.id)).toEqual(['strong']);
    expect(counts).toEqual({ calibrated: 5, scored: 2, probable: 2, separated: 1 });
  });

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
