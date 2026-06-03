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
import { validateSkillCandidateQualityContract } from '@myco/agent/skill-candidate-quality.js';
import { getCandidate } from '@myco/db/queries/skill-candidates.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import { notify } from '@myco/notifications/notify.js';

type Candidate = NonNullable<ReturnType<typeof getCandidate>>;

/**
 * Fetch a candidate once and check it is approved. Returns the loaded row on
 * success so callers needing further checks don't re-query the same row.
 */
function loadApprovedCandidate(
  candidateId: string,
  scope: ProjectScope,
): { candidate: Candidate } | { error: Record<string, unknown> } {
  const candidate = getCandidate(candidateId, scope);
  if (!candidate) {
    return {
      error: {
        error:
          `Candidate ${candidateId} not found. Skill writes require a ` +
          'candidate in the approved state.',
      },
    };
  }
  if (candidate.status !== CANDIDATE_STATUS.APPROVED) {
    return {
      error: {
        error:
          `Candidate ${candidateId} is in '${candidate.status}' state. ` +
          "Skills can only be generated from candidates in 'approved' " +
          'state — the human review step. If a candidate in an earlier ' +
          'state needs to become a skill, route it through the normal ' +
          'approval flow first.',
        candidate_status: candidate.status,
      },
    };
  }
  return { candidate };
}

export function requireApprovedCandidate(
  candidateId: string,
  scope: ProjectScope,
): Record<string, unknown> | null {
  const result = loadApprovedCandidate(candidateId, scope);
  return 'error' in result ? result.error : null;
}

export function requireGenerationReadyCandidate(
  candidateId: string,
  scope: ProjectScope,
): Record<string, unknown> | null {
  const result = loadApprovedCandidate(candidateId, scope);
  if ('error' in result) return result.error;
  const candidate = result.candidate;

  const issues = validateSkillCandidateQualityContract(candidate, {
    requireResolvedSources: true,
    scope,
  });
  if (issues.length > 0) {
    return {
      error:
        `Candidate ${candidateId} is approved but not generation-ready. ` +
        'Approve only candidates with complete, resolvable evidence metadata.',
      issues,
    };
  }

  return null;
}

export function emitSkillNotification(
  vaultDir: string | undefined,
  kind: 'created' | 'evolved',
  opts: { name: string; display_name: string; description: string; recordId: string; generation: number },
): void {
  notify(vaultDir, {
    domain: 'skills',
    type: kind === 'created' ? 'skill.created' : 'skill.evolved',
    title: `Skill ${kind}: ${opts.display_name}`,
    message: opts.description.slice(0, 120),
    link: `/skills?skill=${encodeURIComponent(opts.name)}`,
    metadata: { skillId: opts.recordId, name: opts.name, generation: opts.generation },
  });
}
