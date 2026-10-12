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
 * Hubness-aware relevance selection for prompt injection.
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
   *  hubness baseline). Small mean = central hub. Missing statistics use the
   *  calibrated candidates' pooled distribution. */
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
  /** Keep this fraction of the strongest MP and standardized-distance evidence. */
  relativeBand?: number;
  /** Semantic background from the same record kind and embedding model. */
  referenceCandidates?: SporeCandidate[];
  observe?: (counts: { calibrated: number; scored: number; probable: number; separated: number }) => void;
}

export interface SelectedSpore {
  id: string;
  mp: number;
}

/** Unitless numerical floor for normalized-distance spread; prevents division by zero. */
const STD_EPSILON = 1e-6;
/** Unitless probability midpoint requires mutually-near evidence for spores. */
const DEFAULT_MIN_PROBABILITY = 0.5;
/** Unitless fraction of the strongest spore evidence retains a relative relevance band. */
const DEFAULT_RELATIVE_BAND = 0.6;
/** Unitless sample count requires multiple calibrated spores for a prompt baseline. */
export const SPORE_MIN_CALIBRATION = 5;
/** Unitless probability floor requires stronger mutual evidence for plans. */
const PLAN_MIN_PROBABILITY = 0.75;
/** Unitless fraction of the strongest plan probability keeps a narrow relative band. */
const PLAN_RELATIVE_BAND = 0.9;
/** Unitless sample count requires multiple embedded plans for a distribution baseline. */
export const PLAN_MIN_CALIBRATION = 5;
/** Unitless sample count requires independent spores for prompt-side plan evidence. */
export const PLAN_MIN_QUERY_CANDIDATES = 5;
export type PlanCalibration = 'none' | 'project' | 'insufficient';
/** Unitless standard-deviation bound for the central 95% normal interval of candidate baselines. */
const BASELINE_STD_LIMIT = 2;

type CalibratedCandidate = SporeCandidate & { neighborMean: number; neighborStd: number };

function isCalibrated(c: SporeCandidate): c is CalibratedCandidate {
  return c.neighborMean !== undefined && Number.isFinite(c.neighborMean)
    && c.neighborStd !== undefined && Number.isFinite(c.neighborStd) && c.neighborStd >= 0;
}

function boundedCalibration(candidate: CalibratedCandidate, calibrated: CalibratedCandidate[]): DistributionStats {
  const peers = calibrated.filter((c) => c.id !== candidate.id);
  const baselines = distributionStats(peers.map((c) => c.neighborMean));
  const ceiling = peers.length === 0 ? candidate.neighborMean : baselines.mean + BASELINE_STD_LIMIT * baselines.std;
  return { mean: Math.min(candidate.neighborMean, ceiling), std: candidate.neighborStd };
}

function pooledCalibration(calibrated: CalibratedCandidate[]): DistributionStats {
  const { mean } = distributionStats(calibrated.map((c) => c.neighborMean));
  return {
    mean,
    std: Math.sqrt(calibrated.reduce((sum, c) => sum + c.neighborStd ** 2 + (c.neighborMean - mean) ** 2, 0) / calibrated.length),
  };
}

/**
 * Standard normal CDF via the Abramowitz & Stegun erf approximation
 * (max error ~1.5e-7). Φ(z) = 0.5 · (1 + erf(z / √2)).
 */
export function standardNormalCdf(z: number): number {
  return 0.5 * (1 + erf(z / Math.SQRT2));
}

function erf(x: number): number {
  if (x === 0) return 0;
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
 * factors. Both distributions are required to establish mutual proximity.
 */
export function mutualProximity(
  distance: number,
  queryStats: DistributionStats,
  sporeStats?: DistributionStats,
): number {
  const queryFactor = proximityFactor(distance, queryStats);
  if (!sporeStats) return 0;
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

  const reference = (opts.referenceCandidates ?? candidates).filter(c => Number.isFinite(c.similarity));
  const calibrated = reference.filter(isCalibrated);
  const observe = (scored: number, probable: number, separated: number) => opts.observe?.({ calibrated: calibrated.length, scored, probable, separated });
  const pool = candidates.filter((c) => !c.alreadyInjected && Number.isFinite(c.similarity));
  if (pool.length === 0 || calibrated.length < SPORE_MIN_CALIBRATION) { observe(0, 0, 0); return []; }

  const pooled = pooledCalibration(calibrated);

  const scored = pool
    .map((c) => {
      const queryStats = distributionStats(reference.filter(peer => peer.id !== c.id).map(peer => 1 - peer.similarity));
      const mp = mutualProximity(
        1 - c.similarity,
        queryStats,
        isCalibrated(c) ? boundedCalibration(c, calibrated) : pooled,
      );
      // Query-relative excess retains distance information when probability factors saturate.
      const excess = Math.max(0, (queryStats.mean - (1 - c.similarity)) / Math.max(queryStats.std, STD_EPSILON));
      return { id: c.id, mp, similarity: c.similarity, separation: mp * excess };
    })
    .sort((a, b) => b.mp - a.mp || b.similarity - a.similarity);

  const top = scored[0].mp;
  const cutoff = Math.max(minProbability, top * relativeBand);
  const probable = scored.filter((s) => s.mp >= cutoff);
  const separationCutoff = Math.max(...probable.map((s) => s.separation)) * relativeBand;
  const separated = probable.filter((s) => s.separation >= separationCutoff);
  observe(scored.length, probable.length, separated.length);
  return separated.slice(0, opts.maxResults).map(({ id, mp }) => ({ id, mp }));
}

export function hasPlanCalibration(candidates: SporeCandidate[]): boolean {
  const calibrated = candidates.filter(isCalibrated);
  return calibrated.length >= PLAN_MIN_CALIBRATION && calibrated.every(c => c.neighborStd > STD_EPSILON);
}

/** Embedded plans of any status calibrate centered mutual proximity for live candidates. */
export function selectRelevantPlans(candidates: SporeCandidate[], opts: SelectOptions & {
  /** Independent prompt-side distances from spores in the same model. */
  sporeCandidates?: SporeCandidate[];
  observeCalibration?: (stage: PlanCalibration, queryCandidates: number) => void;
}): SelectedSpore[] {
  const live = candidates.filter((c) => Number.isFinite(c.similarity));
  const calibrated = (opts.referenceCandidates ?? candidates).filter(isCalibrated);
  const queryCandidates = (opts.sporeCandidates ?? []).filter(c => Number.isFinite(c.similarity));
  const queryStats = distributionStats(queryCandidates.map(c => 1 - c.similarity));
  const projectCalibrated = hasPlanCalibration(calibrated)
    && queryCandidates.length >= PLAN_MIN_QUERY_CANDIDATES && queryStats.std > STD_EPSILON;
  const unserved = live.filter(c => !c.alreadyInjected);
  const stage: PlanCalibration = unserved.length === 0 ? 'none' : projectCalibrated ? 'project' : 'insufficient';
  opts.observeCalibration?.(stage, queryCandidates.length);
  if (stage === 'insufficient' || unserved.length === 0) {
    opts.observe?.({ calibrated: calibrated.length, scored: 0, probable: 0, separated: 0 });
    return [];
  }
  const baseline = pooledCalibration(calibrated);
  const scored = unserved.filter(isCalibrated)
    .map((c) => {
      const own = { mean: c.neighborMean, std: c.neighborStd };
      const mp = mutualProximity(1 - c.similarity, queryStats, { mean: own.mean + queryStats.mean - baseline.mean, std: own.std });
      return { id: c.id, mp, similarity: c.similarity };
    })
    .sort((a, b) => b.mp - a.mp || b.similarity - a.similarity);
  const probable = scored.filter((c) => c.mp > (opts.minProbability ?? PLAN_MIN_PROBABILITY));
  const cutoff = (scored[0]?.mp ?? 0) * (opts.relativeBand ?? PLAN_RELATIVE_BAND);
  const separated = probable.filter((c) => c.mp >= cutoff);
  opts.observe?.({ calibrated: calibrated.length, scored: scored.length, probable: probable.length, separated: separated.length });
  return separated.slice(0, opts.maxResults).map(({ id, mp }) => ({ id, mp }));
}
