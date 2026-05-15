/**
 * Skill lifecycle vault tools.
 *
 * 5 tools:
 *   - vault_skill_candidates: CRUD over skill candidate rows. The agent
 *     can only set 'identified' or 'dismissed' on updates; human-only
 *     'approved' transitions go through the UI / MCP approve action, and
 *     'generated' is set internally by vault_finalize_skill.
 *   - vault_skill_records: read/update/delete live skill records.
 *   - vault_write_skill: one-shot create-or-evolve write path used by
 *     skill-evolve and any non-staged skill authoring.
 *   - vault_stage_skill: provisional write used by skill-generate's draft
 *     phase. Stages SKILL.md + manifest.json under .myco/staging/skills/
 *     without touching the live DB or .agents/skills/ directory.
 *   - vault_finalize_skill: promotes a staged skill. Only commit point;
 *     re-runs dedup + validation as defense in depth, then atomically
 *     inserts the skill_records row, lineage, candidate transition to
 *     'generated', disk file, and symlinks. Cleans up staging on success.
 */

import crypto from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds, DEFAULT_LIST_LIMIT } from '@myco/constants.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getDatabase } from '@myco/db/client.js';
import {
  insertCandidate, getCandidate, listCandidates, updateCandidate, deleteCandidate,
} from '@myco/db/queries/skill-candidates.js';
import {
  insertSkillRecord, getSkillRecord, getSkillRecordByName,
  listSkillRecords, updateSkillRecord, deleteSkillRecordCascade,
} from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { notify } from '@myco/notifications/notify.js';
import {
  CANDIDATE_STATUS,
  AGENT_SETTABLE_STATUSES,
} from '@myco/constants/skill-candidate-status.js';
import { parseSourceRefs } from '@myco/agent/skill-candidate-evidence.js';
import {
  validateSkillContent,
  checkFrontmatterPreservation,
  descriptionSimilarity,
  topicOverlapSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
  TOPIC_OVERLAP_THRESHOLD,
} from './skill-validator.js';
import {
  writeStagedSkill,
  readStagedSkill,
  writeStagedManifest,
  readStagedManifest,
  cleanupStagedSkill,
  type StagedManifest,
} from './skill-staging.js';
import { textResult, dryRunResult, projectScopeFromVaultToolDeps, rowProjectIdFromVaultToolDeps, type VaultToolDeps } from './types.js';

const IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE = 0.7;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSkillTools(deps: VaultToolDeps) {
  const { agentId, machineId, projectRoot, vaultDir, embeddingManager, dryRun } = deps;
  const projectId = rowProjectIdFromVaultToolDeps(deps);
  const scope = projectScopeFromVaultToolDeps(deps);

  /**
   * Find the best-matching existing candidate (if any) whose topic
   * overlaps the proposed new topic. Uses a two-path check:
   *
   * 1. Jaccard (`descriptionSimilarity` >= DESCRIPTION_DUPLICATE_THRESHOLD)
   *    — catches classic near-duplicates with similar token counts.
   * 2. Overlap coefficient (`topicOverlapSimilarity` >= TOPIC_OVERLAP_THRESHOLD)
   *    — catches asymmetric kebab-case vs. natural-language duplicates
   *    where a short topic's significant tokens are mostly a subset of
   *    the longer one. Jaccard misses these because the inflated union
   *    pushes the score below 0.4 even when the overlap is strong.
   *
   * Returns the candidate with the highest matching score under either
   * metric. Reported `score` is the max of the two so the rejection
   * message surfaces the stronger signal.
   */
  function findOverlappingCandidate(
    newTopic: string,
    existing: ReturnType<typeof listCandidates>,
  ): { candidate: typeof existing[number]; score: number } | null {
    let best: { candidate: typeof existing[number]; score: number } | null = null;
    for (const candidate of existing) {
      const jaccard = descriptionSimilarity(newTopic, candidate.topic);
      const overlap = topicOverlapSimilarity(newTopic, candidate.topic);
      const hitsJaccard = jaccard >= DESCRIPTION_DUPLICATE_THRESHOLD;
      const hitsOverlap = overlap >= TOPIC_OVERLAP_THRESHOLD;
      if (!hitsJaccard && !hitsOverlap) continue;
      const score = Math.max(jaccard, overlap);
      if (!best || score > best.score) {
        best = { candidate, score };
      }
    }
    return best;
  }

  /**
   * Build a status-aware rejection message. Each status gets guidance
   * that matches the lifecycle: dismissed → stay away; generated →
   * already fulfilled; approved → already queued; identified → update
   * the existing entry instead of duplicating.
   */
  function candidateOverlapError(match: { status: string; topic: string }): string {
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

  function parseJsonArrayParam(
    fieldName: 'quality_failures' | 'coverage_matches',
    value: string | undefined,
  ): { array?: unknown[]; error?: string } {
    if (value === undefined) return {};

    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      return { error: `${fieldName} must be a JSON array` };
    }

    if (!Array.isArray(parsed)) {
      return { error: `${fieldName} must be a JSON array` };
    }
    return { array: parsed };
  }

  function validateCandidateSourceIds(sourceIds: string | undefined): Record<string, unknown> | null {
    if (sourceIds === undefined) return null;
    if (parseSourceRefs(sourceIds).length > 0) return null;
    return { error: 'source_ids must contain at least one valid source reference' };
  }

  function validateCandidateWrite(args: {
    status?: string;
    source_ids?: string;
    evidence_bundle_id?: string | null;
    quality_score?: number | null;
    quality_failures?: string;
    coverage_matches?: string;
  }, existing?: {
    status: string;
    evidence_bundle_id: string | null;
    quality_score: number | null;
    quality_failures: string;
  }): Record<string, unknown> | null {
    const sourceIdsError = validateCandidateSourceIds(args.source_ids);
    if (sourceIdsError) return sourceIdsError;

    const qualityFailures = parseJsonArrayParam('quality_failures', args.quality_failures);
    if (qualityFailures.error) return { error: qualityFailures.error };

    const coverageMatches = parseJsonArrayParam('coverage_matches', args.coverage_matches);
    if (coverageMatches.error) return { error: coverageMatches.error };

    const resultingStatus = args.status ?? existing?.status ?? CANDIDATE_STATUS.IDENTIFIED;
    if (resultingStatus !== CANDIDATE_STATUS.IDENTIFIED) return null;

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

    const qualityFailuresArray = args.quality_failures !== undefined
      ? qualityFailures.array
      : existing !== undefined
        ? parseJsonArrayParam('quality_failures', existing.quality_failures).array
        : undefined;
    if (!qualityFailuresArray || qualityFailuresArray.length > 0) {
      return { error: 'quality_failures must be an empty array for identified skill candidates' };
    }

    return null;
  }

  /**
   * Structural gate enforcing the skill lifecycle invariant: ONLY
   * candidates in 'approved' state can be materialized into skills.
   * Used by vault_stage_skill, vault_finalize_skill, and
   * vault_write_skill's create path.
   */
  function requireApprovedCandidate(
    candidateId: string,
  ): Record<string, unknown> | null {
    const candidate = getCandidate(candidateId, scope);
    if (!candidate) {
      return {
        error:
          `Candidate ${candidateId} not found. Skill writes require a ` +
          'candidate in the approved state.',
      };
    }
    if (candidate.status !== CANDIDATE_STATUS.APPROVED) {
      return {
        error:
          `Candidate ${candidateId} is in '${candidate.status}' state. ` +
          "Skills can only be generated from candidates in 'approved' " +
          'state — the human review step. If a candidate in an earlier ' +
          'state needs to become a skill, route it through the normal ' +
          'approval flow first.',
        candidate_status: candidate.status,
      };
    }
    return null;
  }

  /**
   * Self-contained dedup gate for skill create paths. Returns `null`
   * when the write is allowed, or an error payload object ready for
   * textResult() when it should be rejected.
   *
   * The gate is a no-op on the evolve path (same name as an existing
   * active skill) — the caller does not need to guard the call.
   *
   * Three checks, in order:
   *   (1) Same-name exists: delegate to the evolve path. Return null
   *       so vault_write_skill's existing-record branch can handle it;
   *       callers that only want create (vault_stage_skill,
   *       vault_finalize_skill) opt in via `rejectSameName: true`.
   *   (2) Candidate-already-fulfilled: if the candidate is already
   *       linked to a different-named active skill.
   *   (3) Description similarity: Jaccard on significant-word tokens
   *       against all active skills for this agent.
   */
  function checkDedupGates(args: {
    candidate_id?: string;
    name: string;
    description: string;
    /**
     * When true, treat an existing skill with the same name as a
     * rejection (create-only callers). When false, same-name passes
     * through silently so the caller can dispatch the evolve path.
     */
    rejectSameName?: boolean;
  }): Record<string, unknown> | null {
    // (1) Same-name check
    const existingSameName = getSkillRecordByName(args.name, scope);
    if (existingSameName) {
      if (args.rejectSameName) {
        return {
          error:
            `Skill "${args.name}" already exists. This path is create-only. ` +
            'Use vault_write_skill to evolve the existing skill (it bumps the generation), ' +
            'or mark the current record stale via vault_skill_records first.',
          existing_skill: {
            id: existingSameName.id,
            name: existingSameName.name,
            path: existingSameName.path,
          },
        };
      }
      return null;
    }

    // (2) Candidate-already-fulfilled check
    if (args.candidate_id) {
      const candidate = getCandidate(args.candidate_id, scope);
      if (candidate?.skill_id) {
        const linkedSkill = getSkillRecord(candidate.skill_id, scope);
        if (linkedSkill && linkedSkill.name !== args.name) {
          return {
            error:
              `Candidate ${args.candidate_id} is already fulfilled by skill "${linkedSkill.name}". ` +
              'Do not create a sibling skill. If the existing skill needs changes, ' +
              'write to the same name to evolve it (this bumps its generation), or ' +
              'mark it stale via vault_skill_records before replacing.',
            existing_skill: {
              id: linkedSkill.id,
              name: linkedSkill.name,
              description: linkedSkill.description,
              path: linkedSkill.path,
            },
          };
        }
      }
    }

    // (3) Description similarity check
    const activeSkills = listSkillRecords({ scope, agent_id: agentId, status: 'active', limit: 200 });
    let bestMatch: { skill: typeof activeSkills[number]; score: number } | null = null;
    for (const skill of activeSkills) {
      const score = descriptionSimilarity(args.description, skill.description);
      if (score >= DESCRIPTION_DUPLICATE_THRESHOLD && (!bestMatch || score > bestMatch.score)) {
        bestMatch = { skill, score };
      }
    }
    if (bestMatch) {
      return {
        error:
          `Description overlaps with existing active skill "${bestMatch.skill.name}" ` +
          `(Jaccard ${bestMatch.score.toFixed(2)}, threshold ${DESCRIPTION_DUPLICATE_THRESHOLD}). ` +
          'Do not create a duplicate. Either evolve the existing skill by writing to ' +
          `its name ("${bestMatch.skill.name}"), or reframe this skill so its description ` +
          'describes a distinct procedure.',
        overlapping_skill: {
          id: bestMatch.skill.id,
          name: bestMatch.skill.name,
          description: bestMatch.skill.description,
          path: bestMatch.skill.path,
        },
        similarity: bestMatch.score,
      };
    }

    return null;
  }

  /**
   * Shared create-path promotion: write SKILL.md to the live
   * .agents/skills/<name>/ directory, create symbiont symlinks, then
   * insert the skill_records row + lineage entry in one DB transaction.
   * If the transaction throws, the disk write is reversed so no orphan
   * file survives.
   *
   * Used by both vault_write_skill's create branch and
   * vault_finalize_skill. Evolve (generation > 1) stays inline in
   * vault_write_skill because its rollback semantics differ — it
   * restores prior content rather than deleting the whole directory.
   *
   * `linkCandidate` runs inside the same transaction after the record
   * is inserted. Callers use it for their own candidate-linking policy:
   * vault_write_skill does an exact/prefix search over approved
   * candidates; vault_finalize_skill sets the candidate directly from
   * the staged manifest.
   */
  async function promoteNewSkill(params: {
    name: string;
    display_name: string;
    description: string;
    content: string;
    source_ids?: string;
    candidate_id?: string | null;
    rationale?: string;
    linkCandidate?: (recordId: string, now: number) => void;
    label: string;
  }): Promise<
    | { id: string; name: string; path: string; generation: number }
    | { error: string }
  > {
    const root = projectRoot ?? process.cwd();
    const skillDir = resolve(root, '.agents', 'skills', params.name);
    const skillPath = resolve(skillDir, 'SKILL.md');
    // If the directory already exists for a create, it's an orphan
    // from a prior failed run — we overwrite the file and only remove
    // the file itself on rollback (not the whole directory) to avoid
    // clobbering anything else that may share the dir.
    const skillDirPreexisted = existsSync(skillDir);

    async function cleanupCreatedSkillArtifactsOnRollback(): Promise<void> {
      try {
        if (!skillDirPreexisted) {
          rmSync(skillDir, { recursive: true, force: true });
        } else {
          rmSync(skillPath, { force: true });
        }
      } catch (rollbackErr) {
        console.warn(
          `[${params.label}] file rollback after DB failure also failed:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }

      try {
        const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
        syncSkillSymlinks(root, params.name, { remove: true });
      } catch (rollbackErr) {
        console.warn(
          `[${params.label}] symlink rollback after DB failure also failed:`,
          rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
        );
      }
    }

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(skillPath, params.content, 'utf-8');
    } catch (err) {
      return {
        error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    try {
      const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
      syncSkillSymlinks(root, params.name);
    } catch (err) {
      console.warn(
        `[${params.label}] syncSkillSymlinks failed:`,
        err instanceof Error ? err.message : err,
      );
    }

    const now = epochSeconds();
    const relativePath = `.agents/skills/${params.name}/SKILL.md`;
    const recordId = crypto.randomUUID();
    const generation = 1;

    const txDb = getDatabase();
    try {
      txDb.transaction(() => {
        insertSkillRecord({
          id: recordId,
          project_id: projectId,
          agent_id: agentId,
          machine_id: machineId,
          name: params.name,
          display_name: params.display_name,
          description: params.description,
          candidate_id: params.candidate_id ?? null,
          source_ids: params.source_ids,
          path: relativePath,
          created_at: now,
          updated_at: now,
        });

        insertLineage({
          id: crypto.randomUUID(),
          project_id: projectId,
          skill_id: recordId,
          generation,
          action: 'created',
          rationale: params.rationale ?? 'Initial skill creation',
          source_ids_added: params.source_ids,
          content_snapshot: params.content,
          created_at: now,
        });

        params.linkCandidate?.(recordId, now);
      })();
    } catch (err) {
      await cleanupCreatedSkillArtifactsOnRollback();
      return {
        error: `Skill write aborted: database transaction failed and on-disk state was rolled back. ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      id: recordId,
      name: params.name,
      path: relativePath,
      generation,
    };
  }

  /** Emit the standard notification after a successful create or evolve. */
  function emitSkillNotification(
    kind: 'created' | 'evolved',
    opts: { name: string; display_name: string; description: string; recordId: string; generation: number },
  ) {
    notify(vaultDir, {
      domain: 'skills',
      type: kind === 'created' ? 'skill.created' : 'skill.evolved',
      title: `Skill ${kind}: ${opts.display_name}`,
      message: opts.description.slice(0, 120),
      link: `/skills?skill=${encodeURIComponent(opts.name)}`,
      metadata: { skillId: opts.recordId, name: opts.name, generation: opts.generation },
    });
  }

  const vaultSkillCandidates = tool(
    'vault_skill_candidates',
    'Manage skill candidates (identified topics that may become skills). Supports list, get, create, and update actions.',
    {
      action: z.enum(['list', 'get', 'create', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Candidate ID (required for get/update)'),
      topic: z.string().optional().describe('Skill topic (required for create)'),
      rationale: z.string().optional().describe('Why this should be a skill (required for create)'),
      confidence: z.number().optional().describe('Confidence score 0-1'),
      status: z.enum(AGENT_SETTABLE_STATUSES as readonly [string, ...string[]]).optional().describe(
        "Candidate status — agent-settable values only. 'identified' is " +
        "the initial state; 'dismissed' retires a candidate. 'approved' " +
        "and 'generated' are lifecycle transitions owned by the human UI " +
        'and vault_finalize_skill respectively.',
      ),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      skill_id: z.string().optional().describe('Associated skill record ID (after materialization)'),
      supersedes: z.string().optional().describe('JSON array of skill record names this candidate would replace (for domain-level candidates that subsume existing narrow skills)'),
      evidence_bundle_id: z.string().optional().describe('Evidence bundle ID supporting an identified candidate'),
      quality_score: z.number().optional().describe('Evidence quality score for an identified candidate'),
      quality_failures: z.string().optional().describe('JSON array of quality gate failure identifiers'),
      coverage_matches: z.string().optional().describe('JSON array of existing skill/candidate coverage matches'),
      last_reconciled_at: z.number().optional().describe('Epoch seconds timestamp for the last reconciliation pass'),
      reconciliation_reason: z.string().optional().describe('Reason for the latest reconciliation update'),
      limit: z.number().optional().describe('Maximum candidates to return (for list)'),
    },
    async (args) => {
      switch (args.action) {
        case 'list': {
          const candidates = listCandidates({
            scope,
            agent_id: agentId,
            status: args.status,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(candidates);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const candidate = getCandidate(args.id, scope);
          if (!candidate) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult(candidate);
        }

        case 'create': {
          if (!args.topic || !args.rationale) {
            return textResult({ error: 'topic and rationale are required for create action' });
          }

          const writeError = validateCandidateWrite(args);
          if (writeError) return textResult(writeError);

          // Parse supersedes list (skill names this candidate would replace)
          let supersedesNames: string[] = [];
          if (args.supersedes) {
            try { supersedesNames = JSON.parse(args.supersedes); } catch { /* malformed */ }
          }
          const supersedesSet = new Set(supersedesNames);

          // Guard 1: reject if an active skill already covers this topic.
          // Checks whether all significant words from a skill name appear in the topic.
          // Superseded skills are exempt from this check.
          const activeSkills = listSkillRecords({ scope, agent_id: agentId, status: 'active', limit: 100 });
          const topicLower = args.topic.toLowerCase();
          const overlapping = activeSkills.filter((s) => {
            if (supersedesSet.has(s.name)) return false; // exempt superseded skills
            const nameWords = s.name.split('-').filter((w: string) => w.length > 2);
            if (nameWords.length < 2) return false;
            return nameWords.every((w: string) => topicLower.includes(w));
          });
          if (overlapping.length > 0) {
            return textResult({
              error: 'Candidate rejected: active skill(s) already cover this topic. Update the existing skill via vault_skill_records instead.',
              overlapping_skills: overlapping.map((s) => ({ name: s.name, display_name: s.display_name, description: s.description })),
            });
          }

          // Guard 2: reject if an existing candidate (any status) has an
          // overlapping topic. The skill-survey prompt tells the agent to
          // check dismissed/generated candidates before re-identifying,
          // but self-grading is unreliable so the check is enforced here.
          // Dismissed candidates produce a soft warning rather than a hard rejection.
          const allExisting = listCandidates({ scope, agent_id: agentId, limit: 500 });
          const match = findOverlappingCandidate(args.topic, allExisting);
          let dismissedMatch: typeof match | undefined;
          if (match) {
            if (match.candidate.status === CANDIDATE_STATUS.DISMISSED) {
              dismissedMatch = match;
            } else {
              return textResult({
                error: candidateOverlapError(match.candidate),
                existing_candidate: {
                  id: match.candidate.id,
                  status: match.candidate.status,
                  topic: match.candidate.topic,
                },
                similarity: match.score,
              });
            }
          }

          const now = epochSeconds();
          const candidate = insertCandidate({
            id: crypto.randomUUID(),
            project_id: projectId,
            agent_id: agentId,
            machine_id: machineId,
            topic: args.topic,
            rationale: args.rationale,
            confidence: args.confidence,
            status: args.status,
            source_ids: args.source_ids,
            supersedes: args.supersedes,
            evidence_bundle_id: args.evidence_bundle_id,
            quality_score: args.quality_score,
            quality_failures: args.quality_failures,
            coverage_matches: args.coverage_matches,
            last_reconciled_at: args.last_reconciled_at,
            reconciliation_reason: args.reconciliation_reason,
            created_at: now,
            updated_at: now,
          });
          const result: Record<string, unknown> = { ...candidate };
          if (dismissedMatch) {
            result.warning = candidateOverlapError(dismissedMatch.candidate);
            result.similar_dismissed_candidate = {
              id: dismissedMatch.candidate.id,
              topic: dismissedMatch.candidate.topic,
            };
          }
          notify(vaultDir, {
            domain: 'skills',
            type: 'skill.surveyed',
            title: `Skill candidate: ${args.topic}`,
            message: args.rationale.slice(0, 120),
            link: '/skills?tab=candidates',
            metadata: { candidateId: candidate.id, topic: args.topic },
          });
          return textResult(result);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          const existing = getCandidate(args.id, scope);
          if (!existing) return textResult({ error: `Candidate not found: ${args.id}` });

          const writeError = validateCandidateWrite(args, existing);
          if (writeError) return textResult(writeError);

          const now = epochSeconds();
          const updated = updateCandidate(args.id, {
            ...(args.topic !== undefined ? { topic: args.topic } : {}),
            ...(args.rationale !== undefined ? { rationale: args.rationale } : {}),
            ...(args.confidence !== undefined ? { confidence: args.confidence } : {}),
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            ...(args.skill_id !== undefined ? { skill_id: args.skill_id } : {}),
            ...(args.supersedes !== undefined ? { supersedes: args.supersedes } : {}),
            ...(args.evidence_bundle_id !== undefined ? { evidence_bundle_id: args.evidence_bundle_id } : {}),
            ...(args.quality_score !== undefined ? { quality_score: args.quality_score } : {}),
            ...(args.quality_failures !== undefined ? { quality_failures: args.quality_failures } : {}),
            ...(args.coverage_matches !== undefined ? { coverage_matches: args.coverage_matches } : {}),
            ...(args.last_reconciled_at !== undefined ? { last_reconciled_at: args.last_reconciled_at } : {}),
            ...(args.reconciliation_reason !== undefined ? { reconciliation_reason: args.reconciliation_reason } : {}),
            updated_at: now,
          }, scope);
          if (!updated) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const deleted = deleteCandidate(args.id, scope);
          if (!deleted) return textResult({ error: `Candidate not found: ${args.id}` });
          return textResult({ deleted: true, id: args.id });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultSkillRecords = tool(
    'vault_skill_records',
    'Read, update, and delete skill records (materialized skills on disk). Supports list, get, update, and delete actions. The get action includes the full SKILL.md file content. For update, at least one mutating field (status, generation, source_ids, description, or properties) is required — calls with only {action, id} are rejected to prevent silent no-op updates.',
    {
      action: z.enum(['list', 'get', 'update', 'delete']).describe('Action to perform'),
      id: z.string().optional().describe('Skill record ID or name (required for get/update/delete)'),
      status: z.enum(['active', 'stale', 'retired']).optional().describe('Filter by status or new status (for update)'),
      generation: z.number().optional().describe('New generation number (for update)'),
      source_ids: z.string().optional().describe('JSON array of source IDs (for update)'),
      description: z.string().optional().describe('Updated description (for update)'),
      properties: z.string().optional().describe('JSON-encoded object of properties to MERGE into the existing properties (for update). Example: \'{"last_verified_at": 1776580022}\'. Existing keys not included in the payload are preserved; included keys overwrite. Used by skill-evolve to persist watermarks like last_assessed_at, knowledge_watermark, last_verified_at, last_classification.'),
      limit: z.number().optional().describe('Maximum records to return (for list)'),
    },
    async (args) => {
      switch (args.action) {
        case 'list': {
          const records = listSkillRecords({
            scope,
            agent_id: agentId,
            status: args.status,
            limit: args.limit ?? DEFAULT_LIST_LIMIT,
          });
          return textResult(records);
        }

        case 'get': {
          if (!args.id) return textResult({ error: 'id is required for get action' });
          const record = getSkillRecord(args.id, scope) ?? getSkillRecordByName(args.id, scope);
          if (!record) return textResult({ error: `Skill record not found: ${args.id}` });
          // Include file content so evolve/merge operations can read skill bodies
          const result: Record<string, unknown> = { ...record };
          if (record.path && projectRoot) {
            try {
              result.content = readFileSync(resolve(projectRoot, record.path), 'utf-8');
            } catch {
              // File missing — return record without content
            }
          }
          return textResult(result);
        }

        case 'update': {
          if (!args.id) return textResult({ error: 'id is required for update action' });
          // Structural guard: reject no-op updates so silent-success bugs can't
          // accumulate. Callers that only bump updated_at should not use this path.
          const hasMutatingField = args.status !== undefined
            || args.generation !== undefined
            || args.source_ids !== undefined
            || args.description !== undefined
            || args.properties !== undefined;
          if (!hasMutatingField) {
            return textResult({
              error: 'update action requires at least one mutating field (status, generation, source_ids, description, or properties). Calls with only {action, id} are rejected to prevent silent no-op updates.',
            });
          }

          // Resolve by id or name
          const existing = getSkillRecord(args.id, scope) ?? getSkillRecordByName(args.id, scope);
          if (!existing) return textResult({ error: `Skill record not found: ${args.id}` });

          // Shallow-merge incoming properties into existing so multiple callers
          // (assess, verify) can each write distinct keys without clobbering.
          let mergedProperties: string | undefined;
          if (args.properties !== undefined) {
            let incoming: Record<string, unknown>;
            try {
              const parsed = JSON.parse(args.properties);
              if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return textResult({ error: 'properties must be a JSON-encoded object (not null, array, or primitive).' });
              }
              incoming = parsed as Record<string, unknown>;
            } catch (err) {
              return textResult({ error: `properties is not valid JSON: ${errorMessage(err)}` });
            }
            let existingProps: Record<string, unknown> = {};
            try {
              const parsedExisting = JSON.parse(existing.properties || '{}');
              if (parsedExisting && typeof parsedExisting === 'object' && !Array.isArray(parsedExisting)) {
                existingProps = parsedExisting as Record<string, unknown>;
              }
            } catch (err) {
              // Loud about corrupt stored properties so we don't silently
              // wipe data on the next merge.
              console.warn(`[vault_skill_records] Skill ${existing.id} has unparseable properties; treating as empty for merge. Error: ${errorMessage(err)}`);
            }
            mergedProperties = JSON.stringify({ ...existingProps, ...incoming });
          }

          const now = epochSeconds();
          const updated = updateSkillRecord(existing.id, {
            ...(args.status !== undefined ? { status: args.status } : {}),
            ...(args.generation !== undefined ? { generation: args.generation } : {}),
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            ...(args.description !== undefined ? { description: args.description } : {}),
            ...(mergedProperties !== undefined ? { properties: mergedProperties } : {}),
            updated_at: now,
          }, scope);
          if (!updated) return textResult({ error: `Failed to update skill record: ${existing.id}` });
          return textResult(updated);
        }

        case 'delete': {
          if (!args.id) return textResult({ error: 'id is required for delete action' });
          const result = deleteSkillRecordCascade(args.id, scope);
          if (!result) return textResult({ error: `Skill record not found: ${args.id}` });
          try { embeddingManager?.onRemoved('skill_records', result.id); } catch { /* best-effort */ }
          // Disk + symlink cleanup (best-effort)
          const root = projectRoot ?? process.cwd();
          if (!/[/\\]|\.\./.test(result.name)) {
            const skillDir = resolve(root, '.agents', 'skills', result.name);
            try { rmSync(skillDir, { recursive: true, force: true }); } catch (err) {
              console.warn('[vault_skill_records] Failed to remove skill directory:', err instanceof Error ? err.message : err);
            }
            try {
              const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
              syncSkillSymlinks(root, result.name, { remove: true });
            } catch (err) {
              console.warn('[vault_skill_records] Failed to remove symlinks:', err instanceof Error ? err.message : err);
            }
          }
          return textResult({ deleted: true, id: result.id, name: result.name });
        }

        default:
          return textResult({ error: `Unknown action: ${args.action}` });
      }
    },
    { annotations: {} },
  );

  const vaultWriteSkill = tool(
    'vault_write_skill',
    'Write a SKILL.md file to disk and create or update the corresponding skill record and lineage entry.',
    {
      name: z.string().describe('Skill directory name (kebab-case, NO colon). The myco: prefix goes in the SKILL.md frontmatter name field, not here.'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().describe('Short description of what the skill does'),
      content: z.string().describe('Full SKILL.md content in markdown'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      candidate_id: z.string().optional().describe('Candidate ID that prompted this skill creation'),
      rationale: z.string().optional().describe('Why this skill was created or updated'),
    },
    async (args) => {
      // Validate skill content before writing -- reject malformed skills
      const validationErrors = validateSkillContent(args.content, args.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Skill validation failed. Fix these issues and try again.',
          issues: validationErrors,
        });
      }

      // Path traversal guard -- reject names containing path separators or dot-dot sequences
      if (!args.name || /[/\\]|\.\./.test(args.name)) {
        return textResult({
          error: 'Invalid skill name: must be a simple directory name without path separators or ".."',
        });
      }

      // Dedup gate is self-gating: returns null when same-name exists
      // (the evolve path) so the caller falls through.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: args.name,
        description: args.description,
      });
      if (dedupError) {
        return textResult(dedupError);
      }
      const existing = getSkillRecordByName(args.name, scope);

      const root = projectRoot ?? process.cwd();
      const skillPath = resolve(root, '.agents', 'skills', args.name, 'SKILL.md');

      // Frontmatter preservation guard — when updating an existing skill,
      // reject writes that change protected fields (user-invocable, allowed-tools).
      if (existsSync(skillPath)) {
        const existingContent = readFileSync(skillPath, 'utf-8');
        const violations = checkFrontmatterPreservation(existingContent, args.content);
        if (violations.length > 0) {
          return textResult({
            error: 'Skill update rejected: protected frontmatter fields were changed. Read the existing skill and preserve these values exactly.',
            violations,
          });
        }
      }

      // Create path: delegate to the shared promoteNewSkill helper.
      // Candidate linking uses exact-then-prefix matching since the
      // agent may pass a truncated UUID in the instruction.
      if (!existing) {
        // Structural gate: if the caller passed a candidate_id, the
        // candidate must be in 'approved' state. Evolve path (above)
        // skips this because the caller is updating an existing skill,
        // not materializing a fresh candidate.
        if (args.candidate_id) {
          const candidateError = requireApprovedCandidate(args.candidate_id);
          if (candidateError) {
            return textResult(candidateError);
          }
        }

        const linkCandidate = (recordId: string, now: number) => {
          if (!args.candidate_id) return;
          const exact = updateCandidate(args.candidate_id, {
            status: CANDIDATE_STATUS.GENERATED, skill_id: recordId, updated_at: now,
          }, scope);
          if (exact) return;
          const approvedCandidates = listCandidates({ scope, status: CANDIDATE_STATUS.APPROVED, limit: 10 });
          const prefixMatch = approvedCandidates.find((c) => c.id.startsWith(args.candidate_id!));
          if (prefixMatch) {
            updateCandidate(prefixMatch.id, {
              status: CANDIDATE_STATUS.GENERATED, skill_id: recordId, updated_at: now,
            }, scope);
          }
        };

        const result = await promoteNewSkill({
          name: args.name,
          display_name: args.display_name,
          description: args.description,
          content: args.content,
          source_ids: args.source_ids,
          candidate_id: args.candidate_id,
          rationale: args.rationale,
          linkCandidate,
          label: 'vault_write_skill',
        });
        if ('error' in result) return textResult(result);
        emitSkillNotification('created', {
          name: result.name,
          display_name: args.display_name,
          description: args.description,
          recordId: result.id,
          generation: result.generation,
        });
        embeddingManager?.onContentWritten('skill_records', result.id, args.description, {
          status: 'active',
          name: args.name,
          ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
        }).catch(() => {});
        return textResult(result);
      }

      // Evolve path: update existing record, bump generation, preserve
      // prior SKILL.md content on rollback. This branch stays inline
      // because its rollback semantics (restore prior content) differ
      // from the create helper.
      const priorSkillContent = readFileSync(skillPath, 'utf-8');

      try {
        writeFileSync(skillPath, args.content, 'utf-8');
      } catch (err) {
        return textResult({ error: `Failed to write skill file: ${err instanceof Error ? err.message : String(err)}` });
      }

      try {
        const { syncSkillSymlinks } = await import('@myco/symbionts/installer.js');
        syncSkillSymlinks(root, args.name);
      } catch (err) {
        console.warn('[vault_write_skill] syncSkillSymlinks failed:', err instanceof Error ? err.message : err);
      }

      const now = epochSeconds();
      const relativePath = `.agents/skills/${args.name}/SKILL.md`;
      const generation = existing.generation + 1;
      const recordId = existing.id;

      const txDb = getDatabase();
      try {
        txDb.transaction(() => {
          updateSkillRecord(existing.id, {
            display_name: args.display_name,
            description: args.description,
            generation,
            ...(args.source_ids !== undefined ? { source_ids: args.source_ids } : {}),
            path: relativePath,
            updated_at: now,
          }, scope);

          insertLineage({
            id: crypto.randomUUID(),
            project_id: projectId,
            skill_id: existing.id,
            generation,
            action: 'updated',
            rationale: args.rationale ?? 'Skill content updated',
            source_ids_added: args.source_ids,
            content_snapshot: args.content,
            created_at: now,
          });
        })();
      } catch (err) {
        try {
          writeFileSync(skillPath, priorSkillContent, 'utf-8');
        } catch (rollbackErr) {
          console.warn(
            '[vault_write_skill] file rollback after DB failure also failed:',
            rollbackErr instanceof Error ? rollbackErr.message : rollbackErr,
          );
        }
        return textResult({
          error: `Skill write aborted: database transaction failed and on-disk state was rolled back. ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      emitSkillNotification('evolved', {
        name: args.name,
        display_name: args.display_name,
        description: args.description,
        recordId,
        generation,
      });
      embeddingManager?.onContentWritten('skill_records', recordId, args.description, {
        status: 'active',
        name: args.name,
        ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
      }).catch(() => {});

      return textResult({
        id: recordId,
        name: args.name,
        path: relativePath,
        generation,
      });
    },
    { annotations: { openWorldHint: true } },
  );

  const vaultStageSkill = tool(
    'vault_stage_skill',
    "Stage a provisional SKILL.md under .myco/staging/skills/<candidate_id>/ for later promotion by vault_finalize_skill. Use this from the skill-generate draft phase. The write is NOT live — the skill does not appear under .agents/skills/ and no DB rows are created until vault_finalize_skill is called with the same candidate_id.",
    {
      candidate_id: z.string().describe(
        'Candidate ID from the instruction. Required — staging is keyed by candidate so the validate phase (and on-failure cleanup) can find the staged content.',
      ),
      name: z.string().describe('Final skill directory name (kebab-case, no colon). Stored in the manifest for finalize.'),
      display_name: z.string().describe('Human-readable display name'),
      description: z.string().describe('Short description — used for the dedup gate and the final skill record'),
      content: z.string().describe('Full SKILL.md content in markdown including frontmatter'),
      source_ids: z.string().optional().describe('JSON array of source spore/entity IDs'),
      rationale: z.string().optional().describe('Why this skill is being created — stored in lineage after finalize'),
    },
    async (args) => {
      if (!vaultDir) {
        return textResult({
          error: 'vault_stage_skill requires vaultDir on the tool deps — staging has no location otherwise',
        });
      }

      // Static validation — same rules as vault_write_skill
      const validationErrors = validateSkillContent(args.content, args.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Skill validation failed. Fix these issues and re-stage.',
          issues: validationErrors,
        });
      }

      // Path traversal guard for the skill name (which becomes a directory)
      if (!args.name || /[/\\]|\.\./.test(args.name)) {
        return textResult({
          error: 'Invalid skill name: must be a simple directory name without path separators or ".."',
        });
      }

      // Structural gate: candidate must exist and be in 'approved' state.
      const candidateError = requireApprovedCandidate(args.candidate_id);
      if (candidateError) return textResult(candidateError);

      // Dedup gate — create-only, so rejectSameName surfaces the
      // evolve path as an explicit error. Finalize re-runs the same
      // gate as defense in depth.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: args.name,
        description: args.description,
        rejectSameName: true,
      });
      if (dedupError) return textResult(dedupError);

      // Write staging content + manifest
      let stagingFilePath: string;
      try {
        stagingFilePath = writeStagedSkill(vaultDir, args.candidate_id, args.content);
        const manifest: StagedManifest = {
          candidate_id: args.candidate_id,
          name: args.name,
          display_name: args.display_name,
          description: args.description,
          source_ids: args.source_ids ?? '[]',
          rationale: args.rationale ?? 'Initial draft',
        };
        writeStagedManifest(vaultDir, args.candidate_id, manifest);
      } catch (err) {
        return textResult({
          error: `Failed to write staged skill: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return textResult({
        candidate_id: args.candidate_id,
        staging_path: stagingFilePath,
        status: 'staged',
      });
    },
    { annotations: { openWorldHint: true } },
  );

  const vaultFinalizeSkill = tool(
    'vault_finalize_skill',
    'Promote a staged skill to live at .agents/skills/<name>/ and insert the skill_records / lineage rows. Call this from skill-generate validate phase after your quality checks pass. Requires vault_stage_skill to have been called earlier with the same candidate_id; reads the staged SKILL.md + manifest rather than taking duplicate metadata.',
    {
      candidate_id: z.string().describe('Candidate ID whose staged skill should be promoted. Must match a previous vault_stage_skill call.'),
    },
    async (args) => {
      // Dry-run block: finalize promotes a real skill (writes SKILL.md,
      // inserts skill_records, flips the candidate to 'generated'). None
      // of that can be meaningfully stubbed — the staged dir may not
      // even exist in a dry-run where vault_stage_skill ran for real
      // (staging IS allowed in dry-run) but downstream disk/DB promotion
      // must not happen. Short-circuit with a positive-signal ack.
      if (dryRun) {
        return dryRunResult('vault_finalize_skill', {
          reason: 'finalize blocked in dry-run',
          candidate_id: args.candidate_id,
        });
      }

      if (!vaultDir) {
        return textResult({
          error: 'vault_finalize_skill requires vaultDir on the tool deps',
        });
      }

      // Read staged content + manifest
      const stagedContent = readStagedSkill(vaultDir, args.candidate_id);
      const manifest = readStagedManifest(vaultDir, args.candidate_id);
      if (!stagedContent || !manifest) {
        return textResult({
          error:
            `No staged skill found for candidate ${args.candidate_id}. ` +
            'Call vault_stage_skill first.',
        });
      }

      // Defense-in-depth: candidate must still be 'approved' at
      // finalize time. If a human (or another tool) dismissed the
      // candidate between stage and finalize, the finalize should
      // refuse rather than promote the now-rescinded skill.
      const candidateError = requireApprovedCandidate(args.candidate_id);
      if (candidateError) return textResult(candidateError);

      // Defense-in-depth: re-run validation against the staged content.
      // The staging write already validated once, but the file on disk
      // could have been mutated (tests do this explicitly to check the
      // guard; a crash between stage and finalize could too).
      const validationErrors = validateSkillContent(stagedContent, manifest.name);
      if (validationErrors.length > 0) {
        return textResult({
          error: 'Staged skill failed validation on finalize. Re-stage with valid content.',
          issues: validationErrors,
        });
      }

      // Defense-in-depth: re-run dedup against the manifest-declared
      // description. Catches the "agent staged a fresh description,
      // then tampered the manifest to collide with a live skill" case,
      // and also trips if a concurrent evolve landed a same-named skill
      // between stage and finalize.
      const dedupError = checkDedupGates({
        candidate_id: args.candidate_id,
        name: manifest.name,
        description: manifest.description,
        rejectSameName: true,
      });
      if (dedupError) return textResult(dedupError);

      // Promote via the shared helper. Candidate link is direct — the
      // staged manifest guarantees candidate_id exists, so no search.
      // updateCandidate moves the candidate OUT of 'approved' so its
      // approved_at audit timestamp is preserved by construction.
      const result = await promoteNewSkill({
        name: manifest.name,
        display_name: manifest.display_name,
        description: manifest.description,
        content: stagedContent,
        source_ids: manifest.source_ids,
        candidate_id: manifest.candidate_id,
        rationale: manifest.rationale,
        linkCandidate: (recordId, now) => {
          updateCandidate(manifest.candidate_id, {
            status: CANDIDATE_STATUS.GENERATED,
            skill_id: recordId,
            updated_at: now,
          }, scope);
        },
        label: 'vault_finalize_skill',
      });
      if ('error' in result) return textResult(result);

      // Success — clean up staging and notify.
      cleanupStagedSkill(vaultDir, args.candidate_id);
      emitSkillNotification('created', {
        name: manifest.name,
        display_name: manifest.display_name,
        description: manifest.description,
        recordId: result.id,
        generation: result.generation,
      });
      embeddingManager?.onContentWritten('skill_records', result.id, manifest.description, {
        status: 'active',
        name: manifest.name,
        ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
      }).catch(() => {});

      return textResult(result);
    },
    { annotations: { openWorldHint: true } },
  );

  return [
    vaultSkillCandidates,
    vaultSkillRecords,
    vaultWriteSkill,
    vaultStageSkill,
    vaultFinalizeSkill,
  ];
}
