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
import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';
import { listCandidates } from '@myco/db/queries/skill-candidates.js';
import { buildScheduledCortexInstruction } from '@myco/context/cortex-brief.js';
import { countSpores, getSpore, listSpores } from '@myco/db/queries/spores.js';
import { countSessions, getSession, listSessions } from '@myco/db/queries/sessions.js';
import { listSkillRecords } from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getState, setState } from '@myco/db/queries/agent-state.js';
import { epochSeconds } from '@myco/constants.js';
import { shortlistSemanticIds, type SemanticShortlistProvider } from '@myco/agent/semantic-shortlist.js';
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
  cortex_instruction_input_hash?: string;
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
/** Task name for the Cortex session-start instructions pipeline step. */
export const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';

/** Caps for pre-assembled survey context. */
const SURVEY_MAX_WISDOM_SPORES = 30;
const SURVEY_MAX_SESSIONS = 15;
const SURVEY_MIN_SETTLED_SESSIONS = 2;
const SURVEY_MIN_SETTLED_ACTIVE_SPORES = 3;

/** State key for the survey watermark. */
const SURVEY_WATERMARK_KEY = 'skill-survey-watermark';

export interface SkillSurveyEligibility {
  eligible: boolean;
  reason: 'insufficient-settled-sessions' | 'insufficient-settled-spores' | 'no-new-settled-knowledge' | null;
}

/**
 * Determine whether skill-survey has enough settled knowledge to produce
 * meaningful, project-specific candidates.
 */
export function getSkillSurveyEligibility(agentId?: string): SkillSurveyEligibility {
  const settledSessionCount = countSessions({ includeActive: false });
  if (settledSessionCount < SURVEY_MIN_SETTLED_SESSIONS) {
    return { eligible: false, reason: 'insufficient-settled-sessions' };
  }

  const settledSporeCount = countSpores({ includeActive: false, status: 'active' });
  if (settledSporeCount < SURVEY_MIN_SETTLED_ACTIVE_SPORES) {
    return { eligible: false, reason: 'insufficient-settled-spores' };
  }

  if (!agentId) {
    return { eligible: true, reason: null };
  }

  const watermarkState = getState(agentId, SURVEY_WATERMARK_KEY);
  const watermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  if (watermarkEpoch <= 0) {
    return { eligible: true, reason: null };
  }

  const hasNewSettledSessions = countSessions({
    includeActive: false,
    since: watermarkEpoch,
  }) > 0;
  if (hasNewSettledSessions) {
    return { eligible: true, reason: null };
  }

  const hasNewSettledSpores = countSpores({
    includeActive: false,
    status: 'active',
    since: watermarkEpoch,
  }) > 0;
  if (hasNewSettledSpores) {
    return { eligible: true, reason: null };
  }

  return { eligible: false, reason: 'no-new-settled-knowledge' };
}

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
): BuiltTaskInstruction | undefined {
  const eligibility = getSkillSurveyEligibility(agentId);
  if (!eligibility.eligible) {
    return undefined;
  }

  const now = epochSeconds();

  // Read watermark — 0 means "never surveyed, scan everything"
  const watermarkState = getState(agentId, SURVEY_WATERMARK_KEY);
  const watermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  const sinceFilter = watermarkEpoch > 0 ? { since: watermarkEpoch } : {};

  const parts: string[] = [
    '## Pre-assembled Vault Context',
    '',
    `Survey watermark: ${watermarkEpoch === 0 ? 'first run (full scan)' : new Date(watermarkEpoch * 1000).toISOString()}`,
    `Eligibility gate: requires ${SURVEY_MIN_SETTLED_SESSIONS}+ settled sessions and ${SURVEY_MIN_SETTLED_ACTIVE_SPORES}+ active spores from settled work.`,
    '',
    'CRITICAL: only propose project-specific procedural domains.',
    '- A valid domain must be anchored to this repository\'s components, files, commands, or conventions.',
    '- Generic engineering topics that could apply to any Node/TypeScript/React repo are not candidates.',
    '- If a domain fails repo-specificity or cross-session evidence, reject it instead of creating or updating a candidate.',
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

  // 2. Wisdom spores — highest signal observations.
  // Skill-survey runs against settled work only so spores from in-flight
  // sessions don't bait candidates for procedures that haven't stabilized.
  const wisdomSpores = listSpores({
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

  // 3. Recent decisions and gotchas
  const decisions = listSpores({
    observation_type: 'decision',
    limit: 20,
    includeActive: false,
    ...sinceFilter,
  });
  const gotchas = listSpores({
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

  // 4. Recent sessions
  const sessions = listSessions({
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
export const SKILL_EVOLVE_DEFAULT_MAX_SKILLS_PER_RUN = 3;
const SKILL_EVOLVE_RECENT_SPORE_SCAN_LIMIT = 40;
const SKILL_EVOLVE_RELEVANT_SPORE_LIMIT = 10;
const SKILL_EVOLVE_SEMANTIC_OVERFETCH = 4;
// Keep semantic shortlist rank-based rather than gated on an absolute
// similarity cutoff — cosine scores vary across embedding models.
const SKILL_EVOLVE_SEMANTIC_THRESHOLD = 0;

const SECONDS_PER_HOUR = 3600;

/** A skill that needs assessment — assembled by the instruction builder. */
interface SkillAssessmentEntry {
  id: string;
  name: string;
  generation: number;
  description: string;
  newSporeIds: string[];
  lastAssessedAt: number;
}

/** Pre-computed overlap between two skills for the inventory phase. */
interface SkillOverlapPair {
  skillA: string;
  skillB: string;
  descriptionJaccard: number;
  headingOverlap: number;
  sharedHeadings: string[];
  verdict: 'potential-merge' | 'potential-narrow' | 'distinct';
}

/** Per-skill structural analysis for the inventory phase. */
interface SkillStructure {
  name: string;
  sectionCount: number;
  headings: string[];
  narrow: boolean;
}

function normalizeSkillName(name: string): string {
  return name.replace(/[-_:]+/g, ' ');
}

function buildSporeSearchText(spore: {
  observation_type: string;
  content: string;
  context: string | null;
  tags: string | null;
  file_path: string | null;
}): string {
  return [spore.observation_type, spore.content, spore.context, spore.tags, spore.file_path]
    .filter(Boolean)
    .join(' ');
}

function selectRelevantSporeIdsByLexicalOverlap(
  skill: { name: string; description: string },
  recentSpores: ReturnType<typeof listSpores>,
): string[] {
  if (recentSpores.length === 0) return [];

  const skillName = normalizeSkillName(skill.name);
  const skillQuery = `${skillName} ${skill.description}`;

  return recentSpores
    .map((spore) => {
      const sporeText = buildSporeSearchText(spore);
      const descriptionScore = descriptionSimilarity(skillQuery, sporeText);
      const nameScore = descriptionSimilarity(skillName, sporeText);
      const totalScore = descriptionScore + (nameScore * 1.5);
      return { id: spore.id, totalScore, createdAt: spore.created_at, importance: spore.importance };
    })
    .filter((candidate) => candidate.totalScore > 0)
    .sort((a, b) => {
      if (b.totalScore !== a.totalScore) return b.totalScore - a.totalScore;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.createdAt - a.createdAt;
    })
    .slice(0, SKILL_EVOLVE_RELEVANT_SPORE_LIMIT)
    .map((candidate) => candidate.id);
}

async function selectRelevantSporeIdsForSkill(
  skill: { name: string; description: string },
  sinceEpoch: number,
  retrievalProvider?: SemanticSearchProvider,
): Promise<string[]> {
  const recentSpores = listSpores({
    status: 'active',
    since: sinceEpoch,
    includeActive: false,
    limit: SKILL_EVOLVE_RECENT_SPORE_SCAN_LIMIT,
  });
  if (recentSpores.length === 0) return [];

  const semanticIds = await shortlistSemanticIds({
    provider: retrievalProvider,
    namespace: 'spores',
    query: `${normalizeSkillName(skill.name)} ${skill.description}`,
    candidateIds: new Set(recentSpores.map(spore => spore.id)),
    maxResults: SKILL_EVOLVE_RELEVANT_SPORE_LIMIT,
    overFetch: SKILL_EVOLVE_SEMANTIC_OVERFETCH,
    threshold: SKILL_EVOLVE_SEMANTIC_THRESHOLD,
    filters: {
      status: 'active',
      created_at_gte: sinceEpoch,
    },
  });
  if (semanticIds.length > 0) return semanticIds;

  return selectRelevantSporeIdsByLexicalOverlap(skill, recentSpores);
}

/** Minimum H2 section count for a skill to be considered broad enough. */
const MIN_SECTIONS_FOR_STANDALONE = 2;

/**
 * Extract H2 headings from SKILL.md content (lines starting with "## ").
 * Excludes frontmatter and the top-level H1 title.
 */
function extractHeadings(content: string): string[] {
  // Skip frontmatter
  const bodyMatch = content.match(/^---[\s\S]*?---\n([\s\S]*)$/);
  const body = bodyMatch ? bodyMatch[1] : content;
  return body
    .split('\n')
    .filter(line => line.startsWith('## '))
    .map(line => line.slice(3).trim());
}

/**
 * Compute heading overlap between two skills using tokenized Jaccard
 * on H2 heading text. Returns { score, sharedHeadings }.
 */
function headingOverlap(
  headingsA: string[],
  headingsB: string[],
): { score: number; shared: string[] } {
  if (headingsA.length === 0 || headingsB.length === 0) return { score: 0, shared: [] };

  // Tokenize each heading into significant words (reusing the same stemming logic)
  const tokenize = (h: string) => new Set(
    h.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length >= 4),
  );

  const shared: string[] = [];
  for (const a of headingsA) {
    const aTokens = tokenize(a);
    for (const b of headingsB) {
      const bTokens = tokenize(b);
      const intersection = [...aTokens].filter(t => bTokens.has(t)).length;
      const union = new Set([...aTokens, ...bTokens]).size;
      if (union > 0 && intersection / union >= 0.5) {
        shared.push(`"${a}" ~ "${b}"`);
      }
    }
  }

  // Score: fraction of the smaller skill's headings that have a match
  const smaller = Math.min(headingsA.length, headingsB.length);
  return { score: smaller > 0 ? shared.length / smaller : 0, shared };
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
/**
 * Optional embedding similarity provider. Decoupled from EmbeddingManager
 * so the instruction builder doesn't depend on the daemon's embedding module.
 */
export interface SemanticSearchProvider extends SemanticShortlistProvider {
  pairwiseSimilarity(namespace: string, threshold?: number): Array<{ idA: string; idB: string; similarity: number }>;
}

export async function buildSkillEvolveInstruction(
  params?: Record<string, string | number | boolean>,
  projectRoot?: string,
  retrievalProvider?: SemanticSearchProvider,
): Promise<string> {
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

    const newSporeIds = await selectRelevantSporeIdsForSkill(skill, knowledgeWatermark, retrievalProvider);
    if (newSporeIds.length === 0) continue;

    needsAssessment.push({
      id: skill.id,
      name: skill.name,
      generation: skill.generation,
      description: skill.description,
      newSporeIds,
      lastAssessedAt,
    });
  }

  needsAssessment.sort((a, b) => a.lastAssessedAt - b.lastAssessedAt);
  const selectedSkills = needsAssessment.slice(0, maxSkillsPerRun);

  if (selectedSkills.length === 0) {
    return 'No skills need assessment. All active skills are current or were recently assessed. Report skip via vault_report and finish.';
  }

  // ----- Structural analysis: section counts + heading extraction -----
  // Read each skill's content from disk and extract H2 headings.
  // This gives the inventory phase mechanical signals for narrow/merge
  // detection that don't depend on LLM judgment.
  const structures: SkillStructure[] = [];
  const skillHeadings = new Map<string, string[]>();
  for (const skill of allSkills) {
    let content = '';
    if (projectRoot && skill.path) {
      try { content = readFileSync(resolve(projectRoot, skill.path), 'utf-8'); } catch { /* missing */ }
    }
    const headings = extractHeadings(content);
    skillHeadings.set(skill.name, headings);
    structures.push({
      name: skill.name,
      sectionCount: headings.length,
      headings,
      narrow: headings.length < MIN_SECTIONS_FOR_STANDALONE,
    });
  }

  // ----- Pairwise similarity: description + heading overlap -----
  // Runs after the early-exit so we don't compute O(n²) scores for no-op runs.
  const overlaps: SkillOverlapPair[] = [];
  for (let i = 0; i < allSkills.length; i++) {
    for (let j = i + 1; j < allSkills.length; j++) {
      const a = allSkills[i];
      const b = allSkills[j];
      const descJaccard = descriptionSimilarity(a.description, b.description);
      const aHeadings = skillHeadings.get(a.name) ?? [];
      const bHeadings = skillHeadings.get(b.name) ?? [];
      const ho = headingOverlap(aHeadings, bHeadings);

      // Flag if EITHER description similarity OR heading overlap is significant
      const descFlag = descJaccard >= DESCRIPTION_DUPLICATE_THRESHOLD * 0.75;
      const headingFlag = ho.score >= 0.4;
      if (!descFlag && !headingFlag) continue;

      const verdict = (descJaccard >= DESCRIPTION_DUPLICATE_THRESHOLD || ho.score >= 0.5)
        ? 'potential-merge'
        : 'potential-narrow';

      overlaps.push({
        skillA: a.name,
        skillB: b.name,
        descriptionJaccard: Math.round(descJaccard * 100) / 100,
        headingOverlap: Math.round(ho.score * 100) / 100,
        sharedHeadings: ho.shared,
        verdict,
      });
    }
  }

  const parts: string[] = [
    `${selectedSkills.length} skill(s) need assessment.`,
    `assess_interval_hours: ${assessIntervalHours}`,
    `max_skills_per_run: ${maxSkillsPerRun}`,
  ];

  for (const skill of selectedSkills) {
    parts.push('');
    parts.push('---');
    parts.push(`## Skill: ${skill.name} (gen ${skill.generation})`);
    parts.push(`id: ${skill.id}`);
    parts.push(`description: ${skill.description}`);
    parts.push(`new_spore_ids: ${JSON.stringify(skill.newSporeIds)}`);
    // Full content is NOT included here to keep the instruction lean.
    // Use vault_skill_records (action: get, id: "<name>") to read
    // the full SKILL.md content when you need to verify code references.
  }

  // Inventory section — all active skills with structural signals
  parts.push('');
  parts.push('## All Active Skills (for inventory analysis)');
  for (const s of structures) {
    const skill = allSkills.find(sk => sk.name === s.name)!;
    const narrowTag = s.narrow ? ' **[NARROW — <2 sections]**' : '';
    parts.push(`- **${skill.name}** (gen ${skill.generation}, ${s.sectionCount} sections${narrowTag}): ${skill.description.slice(0, 200)}`);
    if (s.headings.length > 0) {
      parts.push(`  Headings: ${s.headings.join(' | ')}`);
    }
  }

  // Mechanically narrow skills — explicit flags for the inventory phase
  const narrowSkills = structures.filter(s => s.narrow);
  if (narrowSkills.length > 0) {
    parts.push('');
    parts.push('## Mechanically Narrow Skills (<2 H2 sections)');
    parts.push('These skills have insufficient section breadth for domain-level standalone status.');
    parts.push('Determine which broader skill each should be absorbed into.');
    for (const s of narrowSkills) {
      parts.push(`- **${s.name}**: ${s.sectionCount} section(s). Headings: ${s.headings.length > 0 ? s.headings.join(' | ') : '(none)'}`);
    }
  }

  // Pairwise overlap analysis (description tokens + heading overlap)
  if (overlaps.length > 0) {
    parts.push('');
    parts.push('## Pre-computed Token Overlap');
    parts.push('Pairs flagged by description token similarity AND/OR heading overlap:');
    for (const o of overlaps) {
      parts.push(`- **${o.skillA}** <-> **${o.skillB}**: desc=${o.descriptionJaccard}, headings=${o.headingOverlap} (${o.verdict})`);
      if (o.sharedHeadings.length > 0) {
        parts.push(`  Shared headings: ${o.sharedHeadings.join('; ')}`);
      }
    }
  }

  // Semantic similarity from embeddings — strongest signal for overlap detection.
  // Uses cosine similarity on embedded skill descriptions. Catches semantic
  // overlap that token-based methods miss ("adding agent integration" ~= "onboarding a symbiont").
  if (retrievalProvider) {
    // Build a name→id lookup for resolving embedding results
    const idToName = new Map(allSkills.map(s => [s.id, s.name]));

    try {
      const semanticPairs = retrievalProvider.pairwiseSimilarity('skill_records', 0.65);
      if (semanticPairs.length > 0) {
        parts.push('');
        parts.push('## Semantic Similarity (embedding cosine distance)');
        parts.push('Pairs with cosine similarity >= 0.65. This is the STRONGEST overlap signal.');
        parts.push('High similarity (>0.8) means the skills describe nearly identical procedures.');
        for (const p of semanticPairs) {
          const nameA = idToName.get(p.idA) ?? p.idA;
          const nameB = idToName.get(p.idB) ?? p.idB;
          parts.push(`- **${nameA}** <-> **${nameB}**: cosine=${p.similarity}`);
        }
      }
    } catch {
      // Embeddings not available — fall through to token-based signals only
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
export async function buildTaskInstruction(
  taskName: string,
  taskParams?: Record<string, string | number | boolean>,
  agentId?: string,
  projectRoot?: string,
  retrievalProvider?: SemanticSearchProvider,
  config?: MycoConfig,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<BuiltTaskInstruction | undefined> {
  switch (taskName) {
    case SKILL_GENERATE_TASK:
      return buildSkillGenerateInstruction();
    case SKILL_SURVEY_TASK:
      return agentId ? buildSkillSurveyInstruction(agentId) : undefined;
    case SKILL_EVOLVE_TASK: {
      const instruction = await buildSkillEvolveInstruction(taskParams, projectRoot, retrievalProvider);
      return instruction ? { instruction } : undefined;
    }
    case CORTEX_INSTRUCTIONS_TASK: {
      if (!config) return undefined;
      const built = await buildScheduledCortexInstruction(config, getTeamClient);
      return built
        ? {
            instruction: built.instruction,
            context: { cortex_instruction_input_hash: built.inputHash },
          }
        : undefined;
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
 * Generic tasks like vault-evolve never call buildTaskInstruction,
 * so this returns false for them.
 */
export function isInstructionRequiredTask(taskName: string): boolean {
  return taskName === SKILL_GENERATE_TASK
    || taskName === SKILL_EVOLVE_TASK
    || taskName === SKILL_SURVEY_TASK
    || taskName === CORTEX_INSTRUCTIONS_TASK;
}
