import { epochSeconds } from '@myco/constants.js';
import { CANDIDATE_STATUS } from '@myco/constants/skill-candidate-status.js';
import { getState } from '@myco/db/queries/agent-state.js';
import { listCandidates, type CandidateRow } from '@myco/db/queries/skill-candidates.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { countSessions, listSessions } from '@myco/db/queries/sessions.js';
import { listSkillRecords } from '@myco/db/queries/skill-records.js';
import { countSpores, listSpores } from '@myco/db/queries/spores.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import {
  projectScopeFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';
import {
  buildCandidateEvidenceBundles,
  parseSourceRefs,
  renderEvidenceBundlesForPrompt,
} from './skill-candidate-evidence.js';
import {
  IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE,
  IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS,
  SKILL_SURVEY_RECONCILIATION_POLICY_MARKER,
  unknownCandidateQualityFailureCodes,
  type CandidateQualityFailureCode,
} from './skill-candidate-quality.js';

/** Caps for prepared survey context. */
const SURVEY_MAX_WISDOM_SPORES = 30;
const SURVEY_MAX_SESSIONS = 15;
const SURVEY_MAX_EXISTING_CANDIDATES = 200;
const SURVEY_MAX_VISIBLE_NON_ACTIONABLE_CANDIDATES = 10;
const SURVEY_MAX_DIGEST_CHARS = 1600;
const SURVEY_MIN_SETTLED_SESSIONS = 2;
const SURVEY_MIN_SETTLED_ACTIVE_SPORES = 3;
const SURVEY_RECONCILE_STATUSES = [
  CANDIDATE_STATUS.IDENTIFIED,
  CANDIDATE_STATUS.DEFERRED,
] as const;
const SURVEY_SCHEDULED_RECONCILE_STATUSES = [
  CANDIDATE_STATUS.IDENTIFIED,
] as const;

/** State key for the survey watermark. */
export const SKILL_SURVEY_WATERMARK_KEY = 'skill-survey-watermark';

export interface SkillSurveyEligibility {
  eligible: boolean;
  reason: 'insufficient-settled-sessions' | 'insufficient-settled-spores' | 'no-new-settled-knowledge' | null;
}

export interface PreparedSkillCandidate {
  id: string;
  status: string;
  topic: string;
  confidence: number;
  quality_score: number | null;
  quality_failures: string[];
  coverage_matches: string[];
  source_ref_count: number;
  evidence_bundle_id: string | null;
  last_reconciled_at: number | null;
  needs_reconciliation: boolean;
  reconciliation_reasons: string[];
}

export interface PreparedSkillCandidateRef {
  id: string;
  status: string;
  topic: string;
}

export interface PreparedSkillCleanupTarget extends PreparedSkillCandidateRef {
  reconciliation_reasons: string[];
}

export interface SkillSurveyPreparation {
  watermark: {
    ignore_watermark: boolean;
    stored_epoch: number;
    effective_epoch: number;
    label: string;
    next_epoch: number;
  };
  eligibility_gate: {
    min_settled_sessions: number;
    min_settled_active_spores: number;
    eligible: boolean;
    reason: SkillSurveyEligibility['reason'];
  };
  corpus_counts: {
    digest_extracts: number;
    wisdom_spores: number;
    decisions: number;
    gotchas: number;
    sessions: number;
    active_skills: number;
  };
  queue: {
    total: number;
    actionable: number;
    omitted_non_actionable: number;
    status_counts: Record<string, number>;
    candidates: PreparedSkillCandidate[];
    actionable_candidates: PreparedSkillCandidateRef[];
    cleanup_targets: PreparedSkillCleanupTarget[];
    cleanup_target_ids: string[];
  };
  evidence_bundles: ReturnType<typeof buildCandidateEvidenceBundles>;
  prompt_markdown: string;
}

function scopedOptions(scope: ProjectScope): { scope: ProjectScope } {
  return { scope };
}

function listSurveyQueueReconciliationCandidates(
  scope: ProjectScope,
  options: { includeDeferred: boolean; onlyUnreconciled: boolean },
): CandidateRow[] {
  const statuses = options.includeDeferred
    ? [...SURVEY_RECONCILE_STATUSES]
    : [...SURVEY_SCHEDULED_RECONCILE_STATUSES];
  const candidates = listCandidates({
    ...scopedOptions(scope),
    statuses,
    limit: SURVEY_MAX_EXISTING_CANDIDATES,
  });
  if (!options.onlyUnreconciled) return candidates;
  return candidates.filter((candidate) => candidate.last_reconciled_at === null);
}

function compactForPrompt(value: string, maxLength: number): string {
  const compacted = value.replace(/\s+/g, ' ').trim();
  if (compacted.length <= maxLength) return compacted;
  return `${compacted.slice(0, maxLength - 3)}...`;
}

function parseStringArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
}

function statusCounts(candidates: CandidateRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const candidate of candidates) {
    counts[candidate.status] = (counts[candidate.status] ?? 0) + 1;
  }
  return counts;
}

function summarizeCandidate(candidate: CandidateRow): PreparedSkillCandidate {
  const sourceRefCount = parseSourceRefs(candidate.source_ids).length;
  const qualityFailures = parseStringArray(candidate.quality_failures);
  const unknownQualityFailures = unknownCandidateQualityFailureCodes(qualityFailures);
  const coverageMatches = parseStringArray(candidate.coverage_matches);
  const reasons: CandidateQualityFailureCode[] = [];
  const reconciliationReason = candidate.reconciliation_reason ?? '';

  if (candidate.status === CANDIDATE_STATUS.IDENTIFIED) {
    if (candidate.quality_score === null) reasons.push('missing-quality-metadata');
    if (candidate.quality_score !== null && candidate.quality_score < IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE) {
      reasons.push('quality-below-threshold');
    }
    if (qualityFailures.length > 0) reasons.push('identified-has-quality-failures');
    if (coverageMatches.some((match) => match.startsWith('active-skill:') || match.startsWith('skill_'))) {
      reasons.push('active-skill-overlap');
    }
    if (coverageMatches.some((match) => match.startsWith('candidate:'))) {
      reasons.push('existing-candidate-overlap');
    }
    if (!candidate.evidence_bundle_id) reasons.push('missing-evidence-bundle');
    if (sourceRefCount < IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS) reasons.push('insufficient-source-refs');
    if (!hasHumanReviewEvidence(candidate.rationale)) reasons.push('missing-human-review-evidence');
  } else if (
    candidate.status === CANDIDATE_STATUS.DEFERRED &&
    (candidate.last_reconciled_at === null || qualityFailures.length === 0)
  ) {
    reasons.push('deferred-review-required');
  }

  if (unknownQualityFailures.length > 0) {
    reasons.push('invalid-quality-failure-codes');
  }

  if (
    SURVEY_RECONCILE_STATUSES.some((status) => status === candidate.status) &&
    candidate.last_reconciled_at === null
  ) {
    reasons.push('never-reconciled');
  }
  if (
    SURVEY_RECONCILE_STATUSES.some((status) => status === candidate.status) &&
    !reconciliationReason.includes(SKILL_SURVEY_RECONCILIATION_POLICY_MARKER)
  ) {
    reasons.push('stale-reconciliation-policy');
  }

  return {
    id: candidate.id,
    status: candidate.status,
    topic: candidate.topic,
    confidence: candidate.confidence,
    quality_score: candidate.quality_score,
    quality_failures: qualityFailures,
    coverage_matches: coverageMatches,
    source_ref_count: sourceRefCount,
    evidence_bundle_id: candidate.evidence_bundle_id,
    last_reconciled_at: candidate.last_reconciled_at,
    needs_reconciliation: reasons.length > 0,
    reconciliation_reasons: [...new Set(reasons)],
  };
}

const HUMAN_REVIEW_EVIDENCE_MARKERS = [
  'procedure test',
  'project-specificity',
  'project specificity',
  'repeatability',
  'breadth',
  'cross-session',
  'cross session',
  'source evidence',
  'quality score',
  'coverage',
  'overlap',
];

export function hasHumanReviewEvidence(rationale: string | null | undefined): boolean {
  const normalized = (rationale ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (normalized.length < 220) return false;

  const markerCount = HUMAN_REVIEW_EVIDENCE_MARKERS
    .filter((marker) => normalized.includes(marker))
    .length;
  return markerCount >= 3;
}

function visibleCandidateSummaries(candidates: CandidateRow[]): PreparedSkillCandidate[] {
  const summaries = candidates.map(summarizeCandidate);
  const actionable = summaries.filter((candidate) =>
    SURVEY_RECONCILE_STATUSES.some((status) => status === candidate.status),
  );
  const nonActionable = summaries.filter((candidate) =>
    !SURVEY_RECONCILE_STATUSES.some((status) => status === candidate.status),
  );
  return [
    ...actionable,
    ...nonActionable.slice(0, SURVEY_MAX_VISIBLE_NON_ACTIONABLE_CANDIDATES),
  ];
}

function candidateRef(candidate: PreparedSkillCandidate): PreparedSkillCandidateRef {
  return {
    id: candidate.id,
    status: candidate.status,
    topic: candidate.topic,
  };
}

function cleanupTarget(candidate: PreparedSkillCandidate): PreparedSkillCleanupTarget {
  return {
    ...candidateRef(candidate),
    reconciliation_reasons: candidate.reconciliation_reasons,
  };
}

function renderExistingCandidateQueueForPrompt(args: {
  total: number;
  omittedNonActionable: number;
  statusCounts: Record<string, number>;
  candidates: PreparedSkillCandidate[];
  actionable: PreparedSkillCandidateRef[];
  cleanupTargets: PreparedSkillCleanupTarget[];
}): string {
  const lines = [
    `### Existing Candidate Queue (${args.total}; ${args.actionable.length} actionable; ${args.cleanupTargets.length} cleanup targets)`,
    `Status counts: ${JSON.stringify(args.statusCounts)}`,
    `Required cleanup target IDs: ${JSON.stringify(args.cleanupTargets.map((candidate) => candidate.id))}`,
    'Queue reconciliation is real work. Identified/deferred candidates are the active review queue and must be explicitly handled.',
    'Do not infer the queue is clean from a partial list. If cleanup_targets is non-empty, reconcile-queue must plan updates and persist-decisions must write them.',
    'Actionable statuses for skill-survey: identified, deferred. Do not mutate approved or generated candidates; report those as blocked if they look stale.',
  ];

  if (args.candidates.length === 0) {
    lines.push('- (none)');
    return lines.join('\n');
  }

  for (const candidate of args.candidates) {
    const reconciled = candidate.last_reconciled_at
      ? new Date(candidate.last_reconciled_at * 1000).toISOString()
      : 'never';
    const metadata = [
      `confidence ${candidate.confidence}`,
      `quality ${candidate.quality_score ?? 'none'}`,
      `failures ${JSON.stringify(candidate.quality_failures)}`,
      `coverage ${JSON.stringify(candidate.coverage_matches)}`,
      `source_refs ${candidate.source_ref_count}`,
      `evidence_bundle ${candidate.evidence_bundle_id ?? 'none'}`,
      `reconciled ${reconciled}`,
      `needs_reconciliation ${candidate.needs_reconciliation}`,
    ].join('; ');
    lines.push(`- **${candidate.id}** [${candidate.status}] ${compactForPrompt(candidate.topic, 120)} (${metadata})`);
    if (candidate.reconciliation_reasons.length > 0) {
      lines.push(`  reconciliation_reasons: ${JSON.stringify(candidate.reconciliation_reasons)}`);
    }
  }

  if (args.omittedNonActionable > 0) {
    lines.push(`- (${args.omittedNonActionable} non-actionable candidates omitted from this compact prompt; status counts above remain authoritative.)`);
  }

  return lines.join('\n');
}

/**
 * Determine whether skill-survey has enough settled knowledge to produce
 * meaningful, project-specific candidates or existing queue cleanup work.
 */
export function getSkillSurveyEligibility(
  agentId?: string,
  requestContext?: MycoRequestContext,
  options: { ignoreWatermark?: boolean } = {},
): SkillSurveyEligibility {
  const scope = projectScopeFromRequestContext(requestContext);
  const projectId = requestContext!.projectId;
  const queueWork = listSurveyQueueReconciliationCandidates(scope, {
    includeDeferred: options.ignoreWatermark === true,
    onlyUnreconciled: false,
  });
  if (queueWork.some((candidate) => summarizeCandidate(candidate).needs_reconciliation)) {
    return { eligible: true, reason: null };
  }

  const settledSessionCount = countSessions({ ...scopedOptions(scope), includeActive: false });
  if (settledSessionCount < SURVEY_MIN_SETTLED_SESSIONS) {
    return { eligible: false, reason: 'insufficient-settled-sessions' };
  }

  const settledSporeCount = countSpores({ ...scopedOptions(scope), includeActive: false, status: 'active' });
  if (settledSporeCount < SURVEY_MIN_SETTLED_ACTIVE_SPORES) {
    return { eligible: false, reason: 'insufficient-settled-spores' };
  }

  if (!agentId) {
    return { eligible: true, reason: null };
  }

  const watermarkState = getState(agentId, projectId, SKILL_SURVEY_WATERMARK_KEY);
  const watermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  if (watermarkEpoch <= 0) {
    return { eligible: true, reason: null };
  }
  if (options.ignoreWatermark) {
    return { eligible: true, reason: null };
  }

  const hasNewSettledSessions = countSessions({
    ...scopedOptions(scope),
    includeActive: false,
    since: watermarkEpoch,
  }) > 0;
  if (hasNewSettledSessions) {
    return { eligible: true, reason: null };
  }

  const hasNewSettledSpores = countSpores({
    ...scopedOptions(scope),
    includeActive: false,
    status: 'active',
    since: watermarkEpoch,
  }) > 0;
  if (hasNewSettledSpores) {
    return { eligible: true, reason: null };
  }

  return { eligible: false, reason: 'no-new-settled-knowledge' };
}

export function buildSkillSurveyPreparation(
  agentId: string,
  requestContext?: MycoRequestContext,
  options: { ignoreWatermark?: boolean } = {},
): SkillSurveyPreparation {
  const scope = projectScopeFromRequestContext(requestContext);
  const projectId = requestContext!.projectId;
  const ignoreWatermark = options.ignoreWatermark === true;
  const eligibility = getSkillSurveyEligibility(agentId, requestContext, options);

  const watermarkState = getState(agentId, projectId, SKILL_SURVEY_WATERMARK_KEY);
  const storedWatermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  const watermarkEpoch = ignoreWatermark ? 0 : storedWatermarkEpoch;
  const sinceFilter = watermarkEpoch > 0 ? { since: watermarkEpoch } : {};
  const now = epochSeconds();

  const parts: string[] = [
    '## Prepared Skill Survey Context',
    '',
    `Survey watermark: ${watermarkEpoch === 0 ? 'first run (full scan)' : new Date(watermarkEpoch * 1000).toISOString()}`,
    `ignore_watermark: ${ignoreWatermark ? 'true' : 'false'}`,
    `Eligibility gate: requires ${SURVEY_MIN_SETTLED_SESSIONS}+ settled sessions and ${SURVEY_MIN_SETTLED_ACTIVE_SPORES}+ active spores from settled work, unless existing candidates need queue reconciliation.`,
    '',
    'CRITICAL: only propose project-specific procedural domains.',
    '- A valid domain must be anchored to this repository\'s components, files, commands, or conventions.',
    '- Generic engineering topics that could apply to any Node/TypeScript/React repo are not candidates.',
    '- If a domain fails repo-specificity or cross-session evidence, reject it instead of creating or updating a candidate.',
    '- Queue reconciliation mode is allowed even when there are no new evidence bundles. In that mode, focus on existing candidate cleanup: update, defer, or dismiss; create only when a strong bundle passes all gates.',
    '',
  ];

  const digests = listDigestExtracts(agentId, scope);
  if (digests.length > 0) {
    const smallest = digests.reduce((a, b) => a.tier < b.tier ? a : b);
    parts.push('### Digest');
    parts.push(`**Tier ${smallest.tier}** (${smallest.content.length} chars):`);
    parts.push(compactForPrompt(smallest.content, SURVEY_MAX_DIGEST_CHARS));
    parts.push('');
  }

  const wisdomSpores = listSpores({
    ...scopedOptions(scope),
    observation_type: 'wisdom',
    limit: SURVEY_MAX_WISDOM_SPORES,
    includeActive: false,
    ...sinceFilter,
  });
  if (wisdomSpores.length > 0) {
    parts.push(`### Wisdom Spores (${wisdomSpores.length})`);
    for (const s of wisdomSpores) {
      parts.push(`- **${s.id}** (importance ${s.importance}): ${s.content.slice(0, 300)}`);
    }
    parts.push('');
  }

  const decisions = listSpores({
    ...scopedOptions(scope),
    observation_type: 'decision',
    limit: 20,
    includeActive: false,
    ...sinceFilter,
  });
  const gotchas = listSpores({
    ...scopedOptions(scope),
    observation_type: 'gotcha',
    limit: 10,
    includeActive: false,
    ...sinceFilter,
  });
  if (decisions.length > 0 || gotchas.length > 0) {
    parts.push(`### Decisions (${decisions.length}) & Gotchas (${gotchas.length})`);
    for (const s of [...decisions, ...gotchas]) {
      parts.push(`- **${s.observation_type}** ${s.id}: ${s.content.slice(0, 200)}`);
    }
    parts.push('');
  }

  const sessions = listSessions({
    ...scopedOptions(scope),
    limit: SURVEY_MAX_SESSIONS,
    includeActive: false,
    ...sinceFilter,
  });
  if (sessions.length > 0) {
    parts.push(`### Recent Sessions (${sessions.length})`);
    for (const s of sessions) {
      parts.push(`- **${s.id}**: ${s.title ?? '(untitled)'} — ${(s.summary ?? '').slice(0, 200)}`);
    }
    parts.push('');
  }

  const activeSkills = listSkillRecords({ ...scopedOptions(scope), status: 'active', limit: 100 });
  parts.push(`### Active Skills (${activeSkills.length})`);
  for (const s of activeSkills) {
    parts.push(`- **${s.name}**: ${s.description.slice(0, 150)}`);
  }
  parts.push('');

  const existingCandidates = listCandidates({ ...scopedOptions(scope), limit: SURVEY_MAX_EXISTING_CANDIDATES });
  const allVisibleCandidates = visibleCandidateSummaries(existingCandidates);
  const actionableCandidates = allVisibleCandidates.filter((candidate) =>
    SURVEY_RECONCILE_STATUSES.some((status) => status === candidate.status),
  );
  const cleanupTargets = actionableCandidates.filter((candidate) => candidate.needs_reconciliation);
  const actionableRefs = actionableCandidates.map(candidateRef);
  const cleanupTargetRefs = cleanupTargets.map(cleanupTarget);
  const counts = statusCounts(existingCandidates);
  const omittedNonActionable = Math.max(0, existingCandidates.length - allVisibleCandidates.length);
  parts.push(renderExistingCandidateQueueForPrompt({
    total: existingCandidates.length,
    omittedNonActionable,
    statusCounts: counts,
    candidates: allVisibleCandidates,
    actionable: actionableRefs,
    cleanupTargets: cleanupTargetRefs,
  }));
  parts.push('');

  const evidenceBundles = buildCandidateEvidenceBundles({
    wisdomSpores,
    decisions,
    gotchas,
    sessions,
    activeSkills,
    existingCandidates,
  });
  parts.push(renderEvidenceBundlesForPrompt(evidenceBundles));
  parts.push('');

  return {
    watermark: {
      ignore_watermark: ignoreWatermark,
      stored_epoch: storedWatermarkEpoch,
      effective_epoch: watermarkEpoch,
      label: watermarkEpoch === 0 ? 'first run (full scan)' : new Date(watermarkEpoch * 1000).toISOString(),
      next_epoch: now,
    },
    eligibility_gate: {
      min_settled_sessions: SURVEY_MIN_SETTLED_SESSIONS,
      min_settled_active_spores: SURVEY_MIN_SETTLED_ACTIVE_SPORES,
      eligible: eligibility.eligible,
      reason: eligibility.reason,
    },
    corpus_counts: {
      digest_extracts: digests.length,
      wisdom_spores: wisdomSpores.length,
      decisions: decisions.length,
      gotchas: gotchas.length,
      sessions: sessions.length,
      active_skills: activeSkills.length,
    },
    queue: {
      total: existingCandidates.length,
      actionable: actionableCandidates.length,
      omitted_non_actionable: omittedNonActionable,
      status_counts: counts,
      candidates: allVisibleCandidates,
      actionable_candidates: actionableRefs,
      cleanup_targets: cleanupTargetRefs,
      cleanup_target_ids: cleanupTargetRefs.map((candidate) => candidate.id),
    },
    evidence_bundles: evidenceBundles,
    prompt_markdown: parts.join('\n'),
  };
}
