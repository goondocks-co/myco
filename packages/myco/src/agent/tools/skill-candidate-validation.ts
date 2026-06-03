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

import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import {
  IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE,
  IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS,
} from '@myco/agent/skill-candidate-quality.js';
import type { CandidateRow } from '@myco/db/queries/skill-candidates.js';
import type { SkillRecordRow } from '@myco/db/queries/skill-records.js';
import {
  DESCRIPTION_DUPLICATE_THRESHOLD,
  TOPIC_OVERLAP_THRESHOLD,
  descriptionSimilarity,
  topicOverlapSimilarity,
} from './skill-validator.js';
import {
  parseJsonArrayParam,
  parseSupersedesNames,
  validateCandidateSourceIds,
} from './skill-survey-reconciliation.js';

export interface CandidateOverlapMatch {
  candidate: CandidateRow;
  score: number;
}

/**
 * Find the best-matching existing candidate whose topic overlaps the proposed
 * topic. It uses both Jaccard and overlap coefficient because short
 * kebab-case topics are often subsets of longer natural-language topics.
 */
export function findOverlappingCandidates(
  newTopic: string,
  existing: CandidateRow[],
  options: { excludeId?: string } = {},
): CandidateOverlapMatch[] {
  const matches: CandidateOverlapMatch[] = [];
  for (const candidate of existing) {
    if (candidate.id === options.excludeId) continue;
    const jaccard = descriptionSimilarity(newTopic, candidate.topic);
    const overlap = topicOverlapSimilarity(newTopic, candidate.topic);
    const hitsJaccard = jaccard >= DESCRIPTION_DUPLICATE_THRESHOLD;
    const hitsOverlap = overlap >= TOPIC_OVERLAP_THRESHOLD;
    if (!hitsJaccard && !hitsOverlap) continue;
    const score = Math.max(jaccard, overlap);
    matches.push({ candidate, score });
  }
  return matches.sort((a, b) => b.score - a.score);
}

export function candidateOverlapError(match: { status: string; topic: string }): string {
  const common = `already has an existing candidate with a similar topic: "${match.topic}"`;
  switch (match.status) {
    case CANDIDATE_STATUS.DISMISSED:
      return `Note: similar to dismissed candidate "${match.topic}". If this is a broader domain that subsumes the dismissed topic, creation is allowed.`;
    case CANDIDATE_STATUS.GENERATED:
      return `Candidate rejected: the vault ${common} that was already fulfilled by a generated skill. Do not re-identify.`;
    case CANDIDATE_STATUS.APPROVED:
      return `Candidate rejected: the vault ${common} that is already queued in approved state. Wait for the generate task to process it.`;
    case CANDIDATE_STATUS.IDENTIFIED:
      return `Candidate rejected: the vault ${common} already in the review queue. Update the existing candidate with new evidence (action: update) instead of creating a duplicate.`;
    default:
      return `Candidate rejected: the vault ${common} in status '${match.status}'.`;
  }
}

export function checkCandidateCoverage(args: {
  topic: string;
  supersedes?: string | null;
  excludeCandidateId?: string;
  activeSkills: SkillRecordRow[];
  existingCandidates: CandidateRow[];
}): { error?: Record<string, unknown>; dismissedMatch?: CandidateOverlapMatch } {
  const supersedesSet = new Set(parseSupersedesNames(args.supersedes));

  const topicLower = args.topic.toLowerCase();
  const overlapping = args.activeSkills.filter((s) => {
    if (supersedesSet.has(s.name)) return false;
    const nameWords = s.name.split('-').filter((w: string) => w.length > 2);
    if (nameWords.length < 2) return false;
    return nameWords.every((w: string) => topicLower.includes(w));
  });
  if (overlapping.length > 0) {
    return {
      error: {
        error: 'Candidate rejected: active skill(s) already cover this topic. Update the existing skill via vault_skill_records instead.',
        overlapping_skills: overlapping.map((s) => ({ name: s.name, display_name: s.display_name, description: s.description })),
      },
    };
  }

  const matches = findOverlappingCandidates(args.topic, args.existingCandidates, {
    excludeId: args.excludeCandidateId,
  });
  const match = matches.find((entry) => entry.candidate.status !== CANDIDATE_STATUS.DISMISSED)
    ?? matches[0];
  if (!match) return {};
  if (match.candidate.status === CANDIDATE_STATUS.DISMISSED) {
    return { dismissedMatch: match };
  }
  return {
    error: {
      error: candidateOverlapError(match.candidate),
      existing_candidate: {
        id: match.candidate.id,
        status: match.candidate.status,
        topic: match.candidate.topic,
      },
      similarity: match.score,
    },
  };
}

export function validateCandidateWrite(args: {
  status?: string;
  source_ids?: string;
  evidence_bundle_id?: string | null;
  quality_score?: number | null;
  quality_failures?: string;
  coverage_matches?: string;
}, existing?: {
  status: string;
  source_ids: string;
  evidence_bundle_id: string | null;
  quality_score: number | null;
  quality_failures: string;
  coverage_matches: string;
}): { error?: string; normalizedSourceIds?: string } {
  const resultingStatus = args.status ?? existing?.status ?? CANDIDATE_STATUS.IDENTIFIED;
  const sourceIds = resultingStatus === CANDIDATE_STATUS.IDENTIFIED
    ? args.source_ids ?? existing?.source_ids
    : args.source_ids;
  const sourceIdsValidation = validateCandidateSourceIds(sourceIds, {
    required: resultingStatus === CANDIDATE_STATUS.IDENTIFIED,
    minRefs: resultingStatus === CANDIDATE_STATUS.IDENTIFIED ? IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS : 1,
  });
  if (sourceIdsValidation.error) return { error: sourceIdsValidation.error };

  const qualityFailures = parseJsonArrayParam(
    'quality_failures',
    resultingStatus === CANDIDATE_STATUS.IDENTIFIED
      ? args.quality_failures ?? existing?.quality_failures
      : args.quality_failures,
  );
  if (qualityFailures.error) return { error: qualityFailures.error };

  const coverageMatches = parseJsonArrayParam(
    'coverage_matches',
    resultingStatus === CANDIDATE_STATUS.IDENTIFIED
      ? args.coverage_matches ?? existing?.coverage_matches
      : args.coverage_matches,
  );
  if (coverageMatches.error) return { error: coverageMatches.error };

  if (
    (args.status === CANDIDATE_STATUS.DEFERRED || args.status === CANDIDATE_STATUS.DISMISSED) &&
    (!qualityFailures.array || qualityFailures.array.length === 0)
  ) {
    return { error: 'quality_failures must include at least one canonical reason code for deferred or dismissed skill candidates' };
  }

  if (resultingStatus !== CANDIDATE_STATUS.IDENTIFIED) {
    return { normalizedSourceIds: args.source_ids !== undefined ? sourceIdsValidation.normalized : undefined };
  }

  const evidenceBundleId = args.evidence_bundle_id ?? existing?.evidence_bundle_id ?? null;
  if (!evidenceBundleId || evidenceBundleId.trim().length === 0) {
    return { error: 'evidence_bundle_id is required for identified skill candidates' };
  }

  const qualityScore = args.quality_score ?? existing?.quality_score ?? null;
  if (qualityScore === null || qualityScore < IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE) {
    return {
      error: `quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE} for identified skill candidates`,
    };
  }

  if (!qualityFailures.array || qualityFailures.array.length > 0) {
    return { error: 'quality_failures must be an empty array for identified skill candidates' };
  }

  return { normalizedSourceIds: args.source_ids !== undefined ? sourceIdsValidation.normalized : undefined };
}
