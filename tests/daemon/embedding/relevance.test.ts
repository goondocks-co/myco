/**
 * Tests for spore-retrieval relevance selection (hubness-aware, parameter-free).
 *
 * These tests are deliberately MODEL-INDEPENDENT: they assert the selection
 * policy's behavior on score/distance *distributions*, never on absolute cosine
 * values. This is the regression guard for the "same spore injected every
 * prompt" defect — see plan spore-injection-hubness-fix.
 */
import { describe, it, expect } from 'bun:test';
import {
  standardNormalCdf,
  distributionStats,
  mutualProximity,
  selectRelevantSpores,
  type SporeCandidate,
} from '@myco/daemon/embedding/relevance';

// Helper: build a candidate from cosine similarity (distance = 1 - similarity).
function cand(
  id: string,
  similarity: number,
  neighborMean?: number,
  neighborStd?: number,
): SporeCandidate {
  return { id, similarity, neighborMean, neighborStd };
}

describe('standardNormalCdf', () => {
  it('returns 0.5 at the mean', () => {
    expect(standardNormalCdf(0)).toBeCloseTo(0.5, 3);
  });

  it('is monotonic and bounded in (0,1)', () => {
    expect(standardNormalCdf(-3)).toBeLessThan(0.01);
    expect(standardNormalCdf(3)).toBeGreaterThan(0.99);
    expect(standardNormalCdf(-1)).toBeLessThan(standardNormalCdf(1));
  });
});

describe('distributionStats', () => {
  it('computes mean and std of a sample', () => {
    const { mean, std } = distributionStats([0.2, 0.4, 0.6]);
    expect(mean).toBeCloseTo(0.4, 5);
    expect(std).toBeCloseTo(Math.sqrt(((0.2) ** 2 + 0 + (0.2) ** 2) / 3), 5);
  });
});

describe('mutualProximity', () => {
  it('is high when the query is unusually close from BOTH perspectives', () => {
    // distance well below both the query's and the spore's typical distance
    const mp = mutualProximity(
      0.15,
      { mean: 0.5, std: 0.15 },
      { mean: 0.5, std: 0.1 },
    );
    expect(mp).toBeGreaterThan(0.8);
  });

  it('collapses for a spore that is far from the query relative to its own cluster', () => {
    // d=0.6 but the spore is normally 0.45 from its neighbors -> unrelated
    const mp = mutualProximity(
      0.6,
      { mean: 0.55, std: 0.1 },
      { mean: 0.45, std: 0.05 },
    );
    expect(mp).toBeLessThan(0.3);
  });
});

describe('selectRelevantSpores', () => {
  it('T1: flat, low-relevance distribution injects nothing', () => {
    // Every candidate is roughly equidistant and none is close to the query
    // relative to its own cluster -> nothing is actually relevant.
    const candidates = [
      cand('a', 0.40, 0.55, 0.05),
      cand('b', 0.39, 0.55, 0.05),
      cand('c', 0.38, 0.55, 0.05),
      cand('d', 0.37, 0.55, 0.05),
      cand('e', 0.36, 0.55, 0.05),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 3 });
    expect(selected).toEqual([]);
  });

  it('T2: a clear winner injects only the winner', () => {
    const candidates = [
      cand('winner', 0.82, 0.55, 0.05),
      cand('noise1', 0.41, 0.55, 0.05),
      cand('noise2', 0.40, 0.55, 0.05),
      cand('noise3', 0.39, 0.55, 0.05),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 3 });
    expect(selected.map((s) => s.id)).toEqual(['winner']);
  });

  it('T3: a hub (near corpus centroid) is excluded when not truly relevant', () => {
    // The hub is close to EVERYTHING (small neighborMean), so a moderate
    // distance to the query is NOT unusual for it -> demoted. The on-topic
    // cluster member is unusually close to the query -> selected.
    const candidates = [
      cand('topic', 0.80, 0.55, 0.08), // genuinely on-topic, far from rest of corpus
      cand('hub', 0.62, 0.20, 0.05),   // central hub: typically 0.20 from neighbors
      cand('other1', 0.45, 0.55, 0.08),
      cand('other2', 0.44, 0.55, 0.08),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 3 });
    const ids = selected.map((s) => s.id);
    expect(ids).toContain('topic');
    expect(ids).not.toContain('hub');
  });

  it('T4: a central hub is never injected across diverse queries (anti-poisoning)', () => {
    // Simulate N different prompts. Each query has a different on-topic spore,
    // but the same central hub is always a candidate. The hub must never win.
    const hub = cand('hub', 0.60, 0.20, 0.05);
    let hubSelections = 0;
    const N = 6;
    for (let i = 0; i < N; i++) {
      const candidates = [
        cand(`topic-${i}`, 0.78, 0.55, 0.08),
        hub,
        cand(`bg-${i}`, 0.42, 0.55, 0.08),
      ];
      const selected = selectRelevantSpores(candidates, { maxResults: 3 });
      if (selected.some((s) => s.id === 'hub')) hubSelections++;
      // The on-topic spore for this query should be the one injected.
      expect(selected.map((s) => s.id)).toContain(`topic-${i}`);
    }
    expect(hubSelections).toBeLessThanOrEqual(Math.ceil(N / 2));
    expect(hubSelections).toBe(0);
  });

  it('respects maxResults when several spores are genuinely relevant', () => {
    const candidates = [
      cand('r1', 0.85, 0.55, 0.08),
      cand('r2', 0.83, 0.55, 0.08),
      cand('r3', 0.81, 0.55, 0.08),
      cand('r4', 0.80, 0.55, 0.08),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 2 });
    expect(selected.length).toBe(2);
  });

  it('excludes spores already injected this session (dedup)', () => {
    // Realistic over-fetched pool: the highest-similarity spore was already
    // injected this session, so the next genuinely-relevant one is chosen.
    const candidates: SporeCandidate[] = [
      { id: 'seen', similarity: 0.84, neighborMean: 0.55, neighborStd: 0.08, alreadyInjected: true },
      { id: 'fresh', similarity: 0.80, neighborMean: 0.55, neighborStd: 0.08 },
      cand('bg1', 0.42, 0.55, 0.08),
      cand('bg2', 0.41, 0.55, 0.08),
      cand('bg3', 0.40, 0.55, 0.08),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 3 });
    expect(selected.map((s) => s.id)).toEqual(['fresh']);
  });

  it('falls back to query-side only when spore stats are absent (no crash)', () => {
    const candidates = [
      cand('a', 0.85),
      cand('b', 0.42),
      cand('c', 0.41),
    ];
    const selected = selectRelevantSpores(candidates, { maxResults: 3 });
    // With only query-side signal, a strong separation should still surface 'a'.
    expect(selected.map((s) => s.id)).toContain('a');
  });
});
