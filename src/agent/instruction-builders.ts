/**
 * Instruction builders for agent tasks.
 *
 * Pre-assembles data from the vault DB into instruction strings that are
 * injected into agent run prompts. This moves deterministic data assembly
 * out of the LLM loop — the agent receives the material it needs without
 * needing to discover it via tool calls.
 *
 * Each builder corresponds to a task that needs pre-assembled context.
 */

import { listCandidates } from '@myco/db/queries/skill-candidates.js';
import { getSpore, listSporeIdsSince } from '@myco/db/queries/spores.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { listSkillRecords } from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { epochSeconds } from '@myco/constants.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task name that gets special candidate-injection handling. */
export const SKILL_GENERATE_TASK = 'skill-generate';

/** Task name for the skill-evolve pipeline step. */
export const SKILL_EVOLVE_TASK = 'skill-evolve';

// ---------------------------------------------------------------------------
// skill-generate
// ---------------------------------------------------------------------------

/**
 * Build the instruction for a skill-generate run.
 *
 * Fetches the first approved candidate and assembles the full source
 * material (spore content, session summaries) into the instruction text.
 * The draft phase receives this as context — no gathering tool calls needed.
 *
 * Used by both the API route handler and the scheduler.
 */
export function buildSkillGenerateInstruction(): string | undefined {
  const candidates = listCandidates({ status: 'approved', limit: 1 });
  if (candidates.length === 0) return undefined;
  const c = candidates[0];

  const parts = [
    `candidate_id: ${c.id}`,
    `topic: ${c.topic}`,
    `confidence: ${c.confidence}`,
    `rationale: ${c.rationale}`,
    '',
    '## Source Material',
  ];

  let sourceIds: Array<{ id: string; type: string }> = [];
  try { sourceIds = JSON.parse(c.source_ids || '[]'); } catch { /* malformed */ }

  for (const src of sourceIds) {
    if (src.type === 'spore') {
      const spore = getSpore(src.id);
      if (spore) {
        parts.push(`\n### Spore: ${src.id} (${spore.observation_type}, importance ${spore.importance})`);
        parts.push(spore.content);
        if (spore.context) parts.push(`Context: ${spore.context}`);
        if (spore.tags) parts.push(`Tags: ${spore.tags}`);
      }
    } else if (src.type === 'session') {
      const session = getSession(src.id);
      if (session) {
        parts.push(`\n### Session: ${src.id}`);
        if (session.title) parts.push(`Title: ${session.title}`);
        if (session.summary) parts.push(session.summary);
      }
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// skill-evolve
// ---------------------------------------------------------------------------

export const SKILL_EVOLVE_DEFAULT_ASSESS_INTERVAL_HOURS = 24;
export const SKILL_EVOLVE_DEFAULT_MAX_SKILLS_PER_RUN = 5;

const SECONDS_PER_HOUR = 3600;

/** A skill that needs assessment — assembled by the instruction builder. */
interface SkillAssessmentEntry {
  id: string;
  name: string;
  generation: number;
  description: string;
  contentSnapshot: string;
  newSporeIds: string[];
}

/**
 * Build the instruction for a skill-evolve run.
 *
 * Pre-filters active skills that need assessment based on:
 *   - Time since last assessment (assess_interval_hours)
 *   - Whether new spores exist since the skill's knowledge_watermark
 *
 * Skills that pass both checks are assembled with their current content and
 * new spore IDs into a single instruction string. The evolve phase receives
 * this as context — no gathering tool calls needed.
 *
 * @param params - Optional overrides for assess_interval_hours and max_skills_per_run.
 */
export function buildSkillEvolveInstruction(
  params?: Record<string, string | number | boolean>,
): string {
  const assessIntervalHours = Number(params?.assess_interval_hours ?? SKILL_EVOLVE_DEFAULT_ASSESS_INTERVAL_HOURS);
  const maxSkillsPerRun = Number(params?.max_skills_per_run ?? SKILL_EVOLVE_DEFAULT_MAX_SKILLS_PER_RUN);

  const now = epochSeconds();
  const intervalSeconds = assessIntervalHours * 3600;

  const allSkills = listSkillRecords({ status: 'active', limit: 100 });
  const needsAssessment: SkillAssessmentEntry[] = [];

  for (const skill of allSkills) {
    let props: Record<string, unknown> = {};
    try {
      props = JSON.parse(skill.properties || '{}');
    } catch {
      props = {};
    }

    const lastAssessedAt = typeof props.last_assessed_at === 'number' ? props.last_assessed_at : 0;
    const knowledgeWatermark = typeof props.knowledge_watermark === 'number' ? props.knowledge_watermark : 0;

    if (lastAssessedAt > 0 && (now - lastAssessedAt) < intervalSeconds) continue;

    const newSporeIds = listSporeIdsSince(knowledgeWatermark, 10);
    if (newSporeIds.length === 0) continue;

    const lineage = listLineageForSkill(skill.id, 1);
    if (lineage.length === 0) continue;

    needsAssessment.push({
      id: skill.id,
      name: skill.name,
      generation: skill.generation,
      description: skill.description,
      contentSnapshot: lineage[0].content_snapshot,
      newSporeIds,
    });

    if (needsAssessment.length >= maxSkillsPerRun) {
      break;
    }
  }

  if (needsAssessment.length === 0) {
    return 'No skills need assessment. All active skills are current or were recently assessed. Report skip via vault_report and finish.';
  }

  const parts: string[] = [
    `${needsAssessment.length} skill(s) need assessment.`,
    `assess_interval_hours: ${assessIntervalHours}`,
    `max_skills_per_run: ${maxSkillsPerRun}`,
  ];

  for (const skill of needsAssessment) {
    parts.push('');
    parts.push('---');
    parts.push(`## Skill: ${skill.name} (gen ${skill.generation})`);
    parts.push(`id: ${skill.id}`);
    parts.push(`description: ${skill.description}`);
    parts.push(`new_spore_ids: ${JSON.stringify(skill.newSporeIds)}`);
    parts.push('');
    parts.push('### Current Content');
    parts.push('');
    parts.push(skill.contentSnapshot);
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Unified dispatch
// ---------------------------------------------------------------------------

/**
 * Build the pre-assembled instruction for a task that needs one.
 *
 * Returns undefined if the task doesn't need a custom instruction or
 * if no work is available (e.g., no approved candidates for skill-generate).
 *
 * Single dispatch point used by both the scheduler and the API handler.
 */
export function buildTaskInstruction(
  taskName: string,
  taskParams?: Record<string, string | number | boolean>,
): string | undefined {
  switch (taskName) {
    case SKILL_GENERATE_TASK:
      return buildSkillGenerateInstruction();
    case SKILL_EVOLVE_TASK:
      return buildSkillEvolveInstruction(taskParams);
    default:
      return undefined;
  }
}
