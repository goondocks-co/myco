/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Hubness-aware, parameter-free relevance selection for spore injection.
 *
 * Raw cosine similarity is a poor injection gate: an absolute threshold is
 * model-dependent, and long "hub" spores sit near the corpus centroid and look
 * similar to almost any query. This module ranks candidates by Mutual Proximity
 * (MP) — the probability that a candidate is closer-than-typical to the query
 * from BOTH the query's and the spore's own distance distributions — and selects
 * only when there is a clear, distribution-relative signal. MP is in [0,1] and
 * comparable across embedding models, so the gate carries no magic cosine number.
 */

/** A spore candidate returned by KNN, with optional precomputed hubness stats. */
export interface SporeCandidate {
  id: string;
  /** Cosine similarity to the query, in [-1, 1]. Distance = 1 - similarity. */
  similarity: number;
  /** Mean cosine *distance* from this spore to the rest of the corpus (its
   *  hubness baseline). Small mean = central hub. Optional; when absent, MP
   *  falls back to the query-side factor only. */
  neighborMean?: number;
  /** Std-dev of this spore's cosine distance to the corpus. */
  neighborStd?: number;
  /** True when this spore was already injected earlier in the session. */
  alreadyInjected?: boolean;
}

export interface DistributionStats {
  mean: number;
  std: number;
}

export interface SelectOptions {
  /** Max spores to inject. */
  maxResults: number;
  /** Minimum MP probability to inject at all. 0.5 = "more likely than not
   *  mutually-near"; a probability midpoint, not a model-dependent cosine. */
  minProbability?: number;
  /** Keep results within this fraction of the top MP score (separation band). */
  relativeBand?: number;
}

export interface SelectedSpore {
  id: string;
  mp: number;
}

/** Floor for std-devs to avoid division by zero on degenerate distributions. */
const STD_EPSILON = 1e-6;
const DEFAULT_MIN_PROBABILITY = 0.5;
const DEFAULT_RELATIVE_BAND = 0.6;

/**
 * Standard normal CDF via the Abramowitz & Stegun erf approximation
 * (max error ~1.5e-7). Φ(z) = 0.5 · (1 + erf(z / √2)).
 */
export function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

/** Mean and population std-dev of a sample. Empty input → {0, 0}. */
export function distributionStats(values: number[]): DistributionStats {
  if (values.length === 0) return { mean: 0, std: 0 };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance =
    values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, std: Math.sqrt(variance) };
}

/**
 * Probability that `distance` is closer-than-typical given a reference
 * distribution. 1 - Φ(z): high when the distance sits below the distribution's
 * mean (unusually close), low when above it.
 */
function proximityFactor(distance: number, stats: DistributionStats): number {
  const std = Math.max(stats.std, STD_EPSILON);
  return 1 - standardNormalCdf((distance - stats.mean) / std);
}

/**
 * Mutual Proximity: the product of the query-side and spore-side proximity
 * factors. When spore-side stats are absent, only the query-side factor applies.
 */
export function mutualProximity(
  distance: number,
  queryStats: DistributionStats,
  sporeStats?: DistributionStats,
): number {
  const queryFactor = proximityFactor(distance, queryStats);
  if (!sporeStats || sporeStats.std === undefined) return queryFactor;
  return queryFactor * proximityFactor(distance, sporeStats);
}

/**
 * Select spores to inject by Mutual Proximity with a separation gate.
 *
 * Returns [] when nothing clears `minProbability` — i.e. the prompt has no
 * genuinely relevant spore, so we inject nothing rather than poisoning the
 * context with a central hub.
 */
export function selectRelevantSpores(
  candidates: SporeCandidate[],
  opts: SelectOptions,
): SelectedSpore[] {
  const minProbability = opts.minProbability ?? DEFAULT_MIN_PROBABILITY;
  const relativeBand = opts.relativeBand ?? DEFAULT_RELATIVE_BAND;

  const pool = candidates.filter((c) => !c.alreadyInjected);
  if (pool.length === 0) return [];

  const queryStats = distributionStats(pool.map((c) => 1 - c.similarity));

  const scored = pool
    .map((c) => ({
      id: c.id,
      mp: mutualProximity(
        1 - c.similarity,
        queryStats,
        c.neighborStd !== undefined && c.neighborMean !== undefined
          ? { mean: c.neighborMean, std: c.neighborStd }
          : undefined,
      ),
    }))
    .sort((a, b) => b.mp - a.mp);

  const top = scored[0].mp;
  if (top < minProbability) return [];

  const cutoff = Math.max(minProbability, top * relativeBand);
  return scored.filter((s) => s.mp >= cutoff).slice(0, opts.maxResults);
}
