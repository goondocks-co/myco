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

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listCandidates } from '@myco/db/queries/skill-candidates.js';
import { getSpore, listSporeIdsSince, listSpores } from '@myco/db/queries/spores.js';
import { getSession, listSessions } from '@myco/db/queries/sessions.js';
import { listSkillRecords } from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getState, setState } from '@myco/db/queries/agent-state.js';
import { epochSeconds } from '@myco/constants.js';
import {
  descriptionSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
} from './tools/skill-validator.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Task name that gets special candidate-injection handling. */
export const SKILL_GENERATE_TASK = 'skill-generate';

/**
 * Structured run context dispatchers emit alongside the instruction
 * string. Lets the executor and tools react to task metadata without
 * re-parsing the prose instruction.
 */
export interface TaskRunContext {
  candidate_id?: string;
}

/**
 * Instruction + structured context bundle returned from the task
 * dispatcher. The string portion is what the LLM sees; the context
 * portion flows to the executor for hooks like skill-generate's
 * staging cleanup.
 */
export interface BuiltTaskInstruction {
  instruction: string;
  context?: TaskRunContext;
}

/** Task name for the skill-evolve pipeline step. */
export const SKILL_EVOLVE_TASK = 'skill-evolve';

/** Task name for the skill-survey pipeline step. */
export const SKILL_SURVEY_TASK = 'skill-survey';

/** Caps for pre-assembled survey context. */
const SURVEY_MAX_WISDOM_SPORES = 30;
const SURVEY_MAX_SESSIONS = 15;

/** State key for the survey watermark. */
const SURVEY_WATERMARK_KEY = 'skill-survey-watermark';

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
 * Returns both the prose instruction and a structured context bundle
 * so the executor can read `candidate_id` without regex-parsing the
 * instruction string.
 */
export function buildSkillGenerateInstruction(): BuiltTaskInstruction | undefined {
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

  return {
    instruction: parts.join('\n'),
    context: { candidate_id: c.id },
  };
}

// ---------------------------------------------------------------------------
// skill-survey
// ---------------------------------------------------------------------------

/**
 * Build the instruction for a skill-survey run.
 *
 * Pre-assembles a baseline context document from the vault so the explore
 * phase gets zero-turn orientation. Caps the input to keep turn budgets
 * predictable regardless of time gaps between runs. Tracks a watermark
 * via agent_state so subsequent runs process incrementally.
 */
export function buildSkillSurveyInstruction(
  agentId: string,
): BuiltTaskInstruction {
  const now = epochSeconds();

  // Read watermark — 0 means "never surveyed, scan everything"
  const watermarkState = getState(agentId, SURVEY_WATERMARK_KEY);
  const watermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  const sinceFilter = watermarkEpoch > 0 ? { since: watermarkEpoch } : {};

  const parts: string[] = [
    '## Pre-assembled Vault Context',
    '',
    `Survey watermark: ${watermarkEpoch === 0 ? 'first run (full scan)' : new Date(watermarkEpoch * 1000).toISOString()}`,
    '',
  ];

  // 1. Digest — smallest tier only (landscape overview without flooding context).
  // Full digests can be 50K+ chars across tiers; the smallest tier provides
  // sufficient orientation for the explore phase to direct follow-up queries.
  const digests = listDigestExtracts(agentId);
  if (digests.length > 0) {
    const smallest = digests.reduce((a, b) => a.tier < b.tier ? a : b);
    parts.push('### Digest');
    parts.push(`**Tier ${smallest.tier}** (${smallest.content.length} chars):`);
    parts.push(smallest.content);
    parts.push('');
  }

  // 2. Wisdom spores — highest signal observations
  const wisdomSpores = listSpores({
    observation_type: 'wisdom',
    limit: SURVEY_MAX_WISDOM_SPORES,
    ...sinceFilter,
  });
  if (wisdomSpores.length > 0) {
    parts.push(`### Wisdom Spores (${wisdomSpores.length})`);
    for (const s of wisdomSpores) {
      parts.push(`- **${s.id}** (importance ${s.importance}): ${s.content.slice(0, 300)}`);
    }
    parts.push('');
  }

  // 3. Recent decisions and gotchas
  const decisions = listSpores({
    observation_type: 'decision',
    limit: 20,
    ...sinceFilter,
  });
  const gotchas = listSpores({
    observation_type: 'gotcha',
    limit: 10,
    ...sinceFilter,
  });
  if (decisions.length > 0 || gotchas.length > 0) {
    parts.push(`### Decisions (${decisions.length}) & Gotchas (${gotchas.length})`);
    for (const s of [...decisions, ...gotchas]) {
      parts.push(`- **${s.observation_type}** ${s.id}: ${s.content.slice(0, 200)}`);
    }
    parts.push('');
  }

  // 4. Recent sessions
  const sessions = listSessions({
    limit: SURVEY_MAX_SESSIONS,
    ...sinceFilter,
  });
  if (sessions.length > 0) {
    parts.push(`### Recent Sessions (${sessions.length})`);
    for (const s of sessions) {
      parts.push(`- **${s.id}**: ${s.title ?? '(untitled)'} — ${(s.summary ?? '').slice(0, 200)}`);
    }
    parts.push('');
  }

  // 5. Current skill inventory (for dedup awareness)
  const activeSkills = listSkillRecords({ status: 'active', limit: 100 });
  parts.push(`### Active Skills (${activeSkills.length})`);
  for (const s of activeSkills) {
    parts.push(`- **${s.name}**: ${s.description.slice(0, 150)}`);
  }
  parts.push('');

  // Advance watermark
  setState(agentId, SURVEY_WATERMARK_KEY, String(now), now);

  return { instruction: parts.join('\n') };
}

// ---------------------------------------------------------------------------
// skill-evolve
// ---------------------------------------------------------------------------

export const SKILL_EVOLVE_DEFAULT_ASSESS_INTERVAL_HOURS = 24;
export const SKILL_EVOLVE_DEFAULT_MAX_SKILLS_PER_RUN = 8;

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

/** Pre-computed overlap between two skills for the inventory phase. */
interface SkillOverlapPair {
  skillA: string;
  skillB: string;
  jaccard: number;
  verdict: 'potential-merge' | 'potential-narrow' | 'distinct';
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
  projectRoot?: string,
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

    // Read current content from disk (not lineage snapshot which can be stale
    // if the skill was evolved between lineage capture and this run).
    let contentSnapshot = '';
    if (projectRoot && skill.path) {
      try {
        contentSnapshot = readFileSync(resolve(projectRoot, skill.path), 'utf-8');
      } catch {
        // File missing — fall back to lineage snapshot
        const lineage = listLineageForSkill(skill.id, 1);
        contentSnapshot = lineage[0]?.content_snapshot ?? '';
      }
    } else {
      const lineage = listLineageForSkill(skill.id, 1);
      contentSnapshot = lineage[0]?.content_snapshot ?? '';
    }
    if (!contentSnapshot) continue;

    needsAssessment.push({
      id: skill.id,
      name: skill.name,
      generation: skill.generation,
      description: skill.description,
      contentSnapshot,
      newSporeIds,
    });

    if (needsAssessment.length >= maxSkillsPerRun) {
      break;
    }
  }

  if (needsAssessment.length === 0) {
    return 'No skills need assessment. All active skills are current or were recently assessed. Report skip via vault_report and finish.';
  }

  // Pre-compute pairwise similarity for the inventory phase.
  // Runs after the early-exit so we don't compute O(n²) scores for no-op runs.
  const overlaps: SkillOverlapPair[] = [];
  for (let i = 0; i < allSkills.length; i++) {
    for (let j = i + 1; j < allSkills.length; j++) {
      const a = allSkills[i];
      const b = allSkills[j];
      const jaccard = descriptionSimilarity(a.description, b.description);
      if (jaccard >= DESCRIPTION_DUPLICATE_THRESHOLD * 0.75) {
        overlaps.push({
          skillA: a.name,
          skillB: b.name,
          jaccard: Math.round(jaccard * 100) / 100,
          verdict: jaccard >= DESCRIPTION_DUPLICATE_THRESHOLD ? 'potential-merge' : 'potential-narrow',
        });
      }
    }
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

  // Inventory section — all active skills for cross-skill analysis
  parts.push('');
  parts.push('## All Active Skills (for inventory analysis)');
  for (const skill of allSkills) {
    parts.push(`- **${skill.name}** (gen ${skill.generation}): ${skill.description.slice(0, 200)}`);
  }

  if (overlaps.length > 0) {
    parts.push('');
    parts.push('## Pre-computed Description Similarity');
    parts.push('Pairs flagged above threshold (mechanically computed — validate before acting):');
    for (const o of overlaps) {
      parts.push(`- ${o.skillA} <-> ${o.skillB}: ${o.jaccard} (${o.verdict})`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// Unified dispatch
// ---------------------------------------------------------------------------

/**
 * Build the pre-assembled instruction for a task that needs one.
 *
 * Returns undefined if the task doesn't need a custom instruction
 * (generic tasks use their default prompt) OR if no work is available
 * (e.g., no approved candidates for skill-generate, no skills due for
 * assessment for skill-evolve). Dispatchers should combine this with
 * `isInstructionRequiredTask` to distinguish the two cases — see the
 * scheduler's short-circuit for the "no work to do" path.
 *
 * Single dispatch point used by both the scheduler and the API handler.
 */
export function buildTaskInstruction(
  taskName: string,
  taskParams?: Record<string, string | number | boolean>,
  agentId?: string,
  projectRoot?: string,
): BuiltTaskInstruction | undefined {
  switch (taskName) {
    case SKILL_GENERATE_TASK:
      return buildSkillGenerateInstruction();
    case SKILL_SURVEY_TASK:
      return agentId ? buildSkillSurveyInstruction(agentId) : undefined;
    case SKILL_EVOLVE_TASK: {
      const instruction = buildSkillEvolveInstruction(taskParams, projectRoot);
      return instruction ? { instruction } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * True when the task cannot run meaningfully without a pre-assembled
 * instruction — skill-generate needs an approved candidate,
 * skill-evolve needs at least one skill due for assessment. When
 * buildTaskInstruction returns undefined for one of these, the
 * dispatcher must skip the run rather than falling through to the
 * bare default prompt.
 *
 * Generic tasks like full-intelligence never call buildTaskInstruction,
 * so this returns false for them.
 */
export function isInstructionRequiredTask(taskName: string): boolean {
  return taskName === SKILL_GENERATE_TASK
    || taskName === SKILL_EVOLVE_TASK
    || taskName === SKILL_SURVEY_TASK;
}
