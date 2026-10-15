import { describe, expect, it } from 'bun:test';
import { mutualProximity, selectRelevantPlans, selectRelevantSpores, type SporeCandidate } from '../../packages/myco-shared/src/relevance.js';

import cluster from '../fixtures/relevance-cluster.json';

const background = (n = 30): SporeCandidate[] => Array.from({ length: n }, (_, i) => ({
  id: `background-${i}`, similarity: 0.1 + i / 1000, neighborMean: 0.5, neighborStd: 0.1,
}));

describe('prompt relevance', () => {
  it.each([20, 30, 100].flatMap(n => [1 / 10, 1 / 5, 1 / 3, 1 / 2, ...(n === 100 ? [0.8, 0.9] : [])]
    .flatMap(fraction => [false, true].map(exact => ({ n, k: Math.ceil(n * fraction), exact })))))
    ('serves a covered topic among $n candidates ($k matches, exact=$exact)', ({ n, k, exact }) => {
      const trials = n === 100 && k >= 80 ? 16 : 1;
      for (let trial = 0; trial < trials; trial++) {
        const candidates = Array.from({ length: n }, (_, i) => ({
          id: `s${i}`,
          similarity: i < k ? (exact ? 1 : 0.75 + 0.02 * cluster.normal[(i + trial * 7) % 200]!)
            : 0.45 + 0.05 * cluster.normal[(100 + i + trial * 13) % 200]!,
          neighborMean: 0.55, neighborStd: 0.08,
        }));
        const served = selectRelevantSpores(candidates, { maxResults: 7 });
        expect(served.filter(s => Number(s.id.slice(1)) < k).length).toBeGreaterThanOrEqual(Math.min(k, 7));
      }
    });

  it.each([10, 20, 50, 100].flatMap(n => [4, 5].map(z => ({ n, z }))))
    ('admits a single $z-sigma match among $n candidates over frozen backgrounds', ({ n, z }) => {
      for (let trial = 0; trial < 32; trial++) {
        const candidates = Array.from({ length: n }, (_, i) => ({
          id: `s${i}`,
          similarity: 1 - (0.55 + (i === 0 ? -z : cluster.normal[(i + trial * 7) % 200]!) * 0.08),
          neighborMean: 0.55, neighborStd: 0.08,
        }));
        expect(selectRelevantSpores(candidates, { maxResults: 7 }).map(s => s.id)).toContain('s0');
      }
    });

  it.each([20, 30, 100, 368])('requires corpus evidence for a query-close cluster at corpus size %s', n => {
    const k = Math.min(Math.ceil(n / 2), 50);
    for (let trial = 0; trial < 16; trial++) {
      for (const strong of [false, true]) {
        const candidates = Array.from({ length: n }, (_, i) => {
          const similarity = i < k ? 0.88 + 0.02 * cluster.normal[(i + trial * 7) % 200]!
            : 0.2 + 0.05 * cluster.normal[(i + trial * 13) % 200]!;
          const corpusZ = cluster.normalQuantiles[(strong ? 75 + i % 20 : 55 + i % 15)]!;
          return { id: `s${i}`, similarity,
            neighborMean: i < k ? 1 - similarity + corpusZ * 0.08 : 0.55,
            neighborStd: 0.08 };
        }).sort((a, b) => b.similarity - a.similarity).slice(0, 100);
        const selected = selectRelevantSpores(candidates, { maxResults: 7 });
        expect(selected.filter(s => Number(s.id.slice(1)) < k).length).toBe(strong ? 7 : 0);
      }
    }
  });

  it.each([
    { minProbability: 0.36, below: 59, above: 60 },
    { minProbability: 0.64, below: 79, above: 80 },
    { minProbability: 0.81, below: 89, above: 90 },
  ])('applies the corpus floor at the configured probability $minProbability', ({ minProbability, below, above }) => {
    const referenceCandidates = background();
    const candidate = (index: number) => ({
      id: 'boundary', similarity: 0.9,
      neighborMean: 0.1 + cluster.normalQuantiles[index]! * 0.1, neighborStd: 0.1,
    });
    expect(selectRelevantSpores([candidate(below)], { maxResults: 7, referenceCandidates, minProbability })).toEqual([]);
    expect(selectRelevantSpores([candidate(above)], { maxResults: 7, referenceCandidates, minProbability }).map(s => s.id))
      .toEqual(['boundary']);
  });

  it('withholds weak corpus evidence even when the query factor saturates', () => {
    const reference = background();
    const weak = { id: 'weak', similarity: 0.9, neighborMean: 0.12, neighborStd: 0.1 };
    expect(selectRelevantSpores([weak], { maxResults: 7, referenceCandidates: reference })).toEqual([]);
    expect(selectRelevantSpores([{ ...weak, neighborMean: 0.2 }], { maxResults: 7, referenceCandidates: reference }).map(s => s.id))
      .toEqual(['weak']);
  });

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
