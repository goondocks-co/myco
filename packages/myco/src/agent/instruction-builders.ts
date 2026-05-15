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
import { promises as fsPromises } from 'node:fs';
import type { MycoConfig } from '@myco/config/schema.js';
import { sha256Hex } from '@myco/canopy/hash.js';
import { resolveRequestContextForVault } from '@myco/tools/request-context.js';
import {
  computeInputsHash,
  MAP_TASK_PROMPT_VERSION,
  type CanopyEntryInput,
  type RulesFileInput,
} from '@myco/canopy/map/inputs-hash.js';
import { readCanopyMap, type CanopyMapRow } from '@myco/canopy/map/store.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';
import {
  projectScopeFromRequestContext,
  type MycoRequestContext,
} from '@myco/tools/request-context.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { listCandidates } from '@myco/db/queries/skill-candidates.js';
import { describedCanopyEntriesPredicate, CANOPY_ENTRIES_ORDER_BY } from '@myco/db/queries/canopy.js';
import { buildScheduledCortexInstruction } from '@myco/context/cortex-brief.js';
import { getDatabase } from '@myco/db/client.js';
import { countSpores, getSpore, listSpores } from '@myco/db/queries/spores.js';
import { countSessions, getSession, listSessions } from '@myco/db/queries/sessions.js';
import { listSkillRecords, updateSkillRecord } from '@myco/db/queries/skill-records.js';
import { listLineageForSkill } from '@myco/db/queries/skill-lineage.js';
import { listDigestExtracts } from '@myco/db/queries/digest-extracts.js';
import { getState, setState } from '@myco/db/queries/agent-state.js';
import { epochSeconds } from '@myco/constants.js';
import { shortlistSemanticIds, type SemanticShortlistProvider } from '@myco/agent/semantic-shortlist.js';
import { detectDrift, type SkillFileFingerprint } from '@myco/agent/skill-drift.js';
import {
  descriptionSimilarity,
  DESCRIPTION_DUPLICATE_THRESHOLD,
} from './tools/skill-validator.js';
import { renderEvidenceBundlesForPrompt } from './skill-candidate-evidence.js';

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
  canopy_map_inputs_hash?: string;
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
/** Task name for the canopy-describe Tier 2 task. */
export const CANOPY_DESCRIBE_TASK = 'canopy-describe';
/** Task name for the canopy-map Tier 3 task. */
export const CANOPY_MAP_TASK = 'canopy-map';
/** vault_report action that the render phase uses to persist the final map. */
export const CANOPY_MAP_REPORT_ACTION = 'canopy_map';
/** details.content key on the canopy_map vault_report payload. */
export const CANOPY_MAP_CONTENT_KEY = 'content';

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

function scopedOptions(scope: ProjectScope): { scope: ProjectScope } {
  return { scope };
}

/**
 * Determine whether skill-survey has enough settled knowledge to produce
 * meaningful, project-specific candidates.
 */
export function getSkillSurveyEligibility(
  agentId?: string,
  requestContext?: MycoRequestContext,
): SkillSurveyEligibility {
  const scope = projectScopeFromRequestContext(requestContext);
  const projectId = requestContext!.projectId;
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

  const watermarkState = getState(agentId, projectId, SURVEY_WATERMARK_KEY);
  const watermarkEpoch = watermarkState ? Number(watermarkState.value) : 0;
  if (watermarkEpoch <= 0) {
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
export function buildSkillGenerateInstruction(
  requestContext?: MycoRequestContext,
): BuiltTaskInstruction | undefined {
  const scope = projectScopeFromRequestContext(requestContext);
  const candidates = listCandidates({ ...scopedOptions(scope), status: 'approved', limit: 1 });
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
      const spore = getSpore(src.id, scope);
      if (spore) {
        parts.push(`\n### Spore: ${src.id} (${spore.observation_type}, importance ${spore.importance})`);
        parts.push(spore.content);
        if (spore.context) parts.push(`Context: ${spore.context}`);
        if (spore.tags) parts.push(`Tags: ${spore.tags}`);
      }
    } else if (src.type === 'session') {
      const session = getSession(src.id, scope);
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
  requestContext?: MycoRequestContext,
): BuiltTaskInstruction | undefined {
  const scope = projectScopeFromRequestContext(requestContext);
  const projectId = requestContext!.projectId;
  const eligibility = getSkillSurveyEligibility(agentId, requestContext);
  if (!eligibility.eligible) {
    return undefined;
  }

  const now = epochSeconds();

  // Read watermark — 0 means "never surveyed, scan everything"
  const watermarkState = getState(agentId, projectId, SURVEY_WATERMARK_KEY);
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
  const digests = listDigestExtracts(agentId, scope);
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

  // 3. Recent decisions and gotchas
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

  // 4. Recent sessions
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

  // 5. Current skill inventory (for dedup awareness)
  const activeSkills = listSkillRecords({ ...scopedOptions(scope), status: 'active', limit: 100 });
  parts.push(`### Active Skills (${activeSkills.length})`);
  for (const s of activeSkills) {
    parts.push(`- **${s.name}**: ${s.description.slice(0, 150)}`);
  }
  parts.push('');

  // 6. Candidate evidence bundles
  parts.push(renderEvidenceBundlesForPrompt([]));
  parts.push('');

  // Advance watermark
  setState(agentId, projectId, SURVEY_WATERMARK_KEY, String(now), now);

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

interface SemanticPair {
  idA: string;
  idB: string;
  similarity: number;
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
  retrievalProvider: SemanticSearchProvider | undefined,
  scope: ProjectScope,
): Promise<string[]> {
  const recentSpores = listSpores({
    ...scopedOptions(scope),
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
      ...(scope.kind === 'project' ? { project_id: scope.id } : {}),
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

function parseSkillProperties(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function selectOutlierPairs(
  pairs: SemanticPair[],
  opts: { kSigma: number; minSamples: number },
): SemanticPair[] {
  if (pairs.length < opts.minSamples) return [];
  const values = pairs.map(p => p.similarity);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  const stddev = Math.sqrt(variance);
  const cutoff = mean + (opts.kSigma * stddev);
  return pairs.filter(pair => pair.similarity > cutoff);
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
  requestContext?: MycoRequestContext,
): Promise<string | undefined> {
  const scope = projectScopeFromRequestContext(requestContext);
  const assessIntervalHours = Number(params?.assess_interval_hours ?? SKILL_EVOLVE_DEFAULT_ASSESS_INTERVAL_HOURS);
  const maxSkillsPerRun = Number(params?.max_skills_per_run ?? SKILL_EVOLVE_DEFAULT_MAX_SKILLS_PER_RUN);

  const now = epochSeconds();
  const intervalSeconds = assessIntervalHours * 3600;

  const allSkills = listSkillRecords({ ...scopedOptions(scope), status: 'active', limit: 100 });
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

    const newSporeIds = await selectRelevantSporeIdsForSkill(skill, knowledgeWatermark, retrievalProvider, scope);
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

  // ----- Structural analysis: section counts + heading extraction -----
  // Read each skill's content from disk and extract H2 headings.
  // This gives the inventory phase mechanical signals for narrow/merge
  // detection that don't depend on LLM judgment.
  const structures: SkillStructure[] = [];
  const skillHeadings = new Map<string, string[]>();
  if (projectRoot) {
    for (const skill of allSkills) {
      let content = '';
      if (skill.path) {
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
  }

  // ----- Pairwise similarity: description + heading overlap -----
  // Runs after the early-exit so we don't compute O(n²) scores for no-op runs.
  const overlaps: SkillOverlapPair[] = [];
  if (projectRoot) {
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
  }

  const narrowSkills = structures.filter(s => s.narrow);

  const nowEpoch = epochSeconds();
  const oldestForVerify = [...allSkills]
    .sort((a, b) => {
      const propsA = parseSkillProperties(a.properties);
      const propsB = parseSkillProperties(b.properties);
      const tsA = typeof propsA.last_verified_at === 'number' ? propsA.last_verified_at : 0;
      const tsB = typeof propsB.last_verified_at === 'number' ? propsB.last_verified_at : 0;
      return tsA - tsB;
    })
    .slice(0, 5);
  const drift = projectRoot
    ? detectDrift(oldestForVerify, projectRoot, nowEpoch)
    : {
        verifiedAt: nowEpoch,
        reports: [],
        totalMissing: 0,
        totalInconclusive: 0,
        totalGrowth: 0,
      };

  for (const skill of oldestForVerify) {
    const report = drift.reports.find(r => r.skillId === skill.id);
    const props = parseSkillProperties(skill.properties);
    const mergedFingerprints: Record<string, SkillFileFingerprint> = {
      ...(props.file_fingerprints && typeof props.file_fingerprints === 'object'
        ? props.file_fingerprints as Record<string, SkillFileFingerprint>
        : {}),
    };

    if (report) {
      for (const [path, fingerprint] of Object.entries(report.currentFingerprints)) {
        if (!mergedFingerprints[path]) {
          mergedFingerprints[path] = fingerprint;
        }
      }
    }

    props.last_verified_at = nowEpoch;
    props.file_fingerprints = mergedFingerprints;
    updateSkillRecord(skill.id, {
      updated_at: nowEpoch,
      properties: JSON.stringify(props),
    }, scope);
  }

  let semanticPairs: Array<{ idA: string; idB: string; similarity: number }> = [];
  if (retrievalProvider && projectRoot) {
    try {
      const skillIds = new Set(allSkills.map((skill) => skill.id));
      const allPairs = retrievalProvider.pairwiseSimilarity('skill_records', 0);
      semanticPairs = selectOutlierPairs(
        allPairs.filter((pair) => skillIds.has(pair.idA) && skillIds.has(pair.idB)),
        { kSigma: 2, minSamples: 10 },
      );
    } catch {
      semanticPairs = [];
    }
  }

  const anyWork = selectedSkills.length > 0
    || overlaps.length > 0
    || narrowSkills.length > 0
    || semanticPairs.length > 0
    || drift.totalMissing > 0
    || drift.totalInconclusive > 0
    || drift.totalGrowth > 0;
  if (!anyWork) return undefined;

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
  if (retrievalProvider && projectRoot) {
    // Build a name→id lookup for resolving embedding results
    const idToName = new Map(allSkills.map(s => [s.id, s.name]));

    if (semanticPairs.length > 0) {
      parts.push('');
      parts.push('## Semantic Similarity (distribution outliers)');
      parts.push('Pairs selected by outlier filtering (mu + 2sigma) over this run\'s pairwise distribution.');
      for (const p of semanticPairs) {
        const nameA = idToName.get(p.idA) ?? p.idA;
        const nameB = idToName.get(p.idB) ?? p.idB;
        parts.push(`- **${nameA}** <-> **${nameB}**: cosine=${p.similarity}`);
      }
    }
  }

  parts.push('');
  parts.push('## Pre-computed Drift Report');
  parts.push(`verified_at: ${drift.verifiedAt}`);
  parts.push(`totals: missing=${drift.totalMissing}, inconclusive=${drift.totalInconclusive}, growth=${drift.totalGrowth}`);
  for (const report of drift.reports) {
    parts.push(`- **${report.name}**: severity=${report.severity}, confidence=${report.confidence}`);
    if (report.loadBearingMisses.length > 0) {
      parts.push(`  load_bearing_misses: ${JSON.stringify(report.loadBearingMisses)}`);
    }
    if (report.inconclusive.length > 0) {
      parts.push(`  inconclusive: ${JSON.stringify(report.inconclusive)}`);
    }
    if (report.growth.length > 0) {
      parts.push(`  growth: ${JSON.stringify(report.growth)}`);
    }
    if (Object.keys(report.currentFingerprints).length > 0) {
      parts.push(`  current_fingerprints: ${JSON.stringify(report.currentFingerprints)}`);
    }
  }

  return parts.join('\n');
}

// ---------------------------------------------------------------------------
// canopy-map
// ---------------------------------------------------------------------------

/**
 * Canopy entries representative cap. Bounded to keep render-phase prompt
 * within reasonable token budgets across model providers (Anthropic Sonnet,
 * local 32K-context models). Larger repos get a representative slice rather
 * than a degraded prompt. The deterministic alphabetical (path-sorted)
 * truncation keeps the inputs_hash stable run-over-run.
 */
const CANOPY_MAP_MAX_ENTRIES = 300;

/** Default rules-file filenames searched at the project root. */
const CANOPY_MAP_ROOT_RULES_FILES = ['AGENTS.md', 'CLAUDE.md'];
/** Directory under which every file is treated as a rules file. */
const CANOPY_MAP_RULES_DIRS = ['.cursor/rules'];

interface CanopyMapGatherContext {
  projectId: string;
  priorMap: CanopyMapRow | null;
  canopyEntries: CanopyEntryInput[];
  rulesFiles: RulesFileInput[];
  inputsHash: string;
  forceColdStart: boolean;
}

async function loadRulesFiles(projectRoot: string): Promise<RulesFileInput[]> {
  const out: RulesFileInput[] = [];

  for (const filename of CANOPY_MAP_ROOT_RULES_FILES) {
    const absPath = resolve(projectRoot, filename);
    try {
      const buf = await fsPromises.readFile(absPath);
      out.push({ filename, content_hash: sha256Hex(buf) });
    } catch {
      // missing file — skip
    }
  }

  for (const dir of CANOPY_MAP_RULES_DIRS) {
    const absDir = resolve(projectRoot, dir);
    let entries: string[] = [];
    try {
      entries = await fsPromises.readdir(absDir);
    } catch {
      continue;
    }
    for (const name of entries.sort()) {
      const absPath = resolve(absDir, name);
      try {
        const stat = await fsPromises.stat(absPath);
        if (!stat.isFile()) continue;
        const buf = await fsPromises.readFile(absPath);
        out.push({ filename: `${dir}/${name}`, content_hash: sha256Hex(buf) });
      } catch {
        // skip unreadable entries
      }
    }
  }

  return out;
}

/**
 * Cheap COUNT for the no-op gate. Lets gatherCanopyMapContext skip the
 * full SELECT + hash work when the described-rows pool is empty without
 * paying for the projection. Mirrors the predicate used by
 * loadDescribedCanopyEntries so the count and the subsequent SELECT can
 * never disagree.
 */
function countDescribedCanopyEntries(projectId: string): number {
  const { where, params } = describedCanopyEntriesPredicate(projectId);
  const row = getDatabase()
    .prepare(`SELECT COUNT(*) AS n FROM canopy_entries WHERE ${where}`)
    .get(...params) as { n: number };
  return row.n;
}

function loadDescribedCanopyEntries(projectId: string): CanopyEntryInput[] {
  const { where, params } = describedCanopyEntriesPredicate(projectId);
  const rows = getDatabase().prepare(
    `SELECT path, content_hash, llm_description
       FROM canopy_entries
      WHERE ${where}
      ORDER BY ${CANOPY_ENTRIES_ORDER_BY}
      LIMIT ?`,
  ).all(...params, CANOPY_MAP_MAX_ENTRIES) as Array<{
    path: string;
    content_hash: string;
    llm_description: string | null;
  }>;
  return rows.map((r) => ({
    path: r.path,
    content_hash: r.content_hash,
    llm_description: r.llm_description ?? null,
  }));
}

/**
 * Skip envelope returned by gatherCanopyMapContext when the run would be a
 * no-op. `reason` distinguishes:
 *   - 'canopy_disabled': cortex.canopy.inject_on_pre_tool_use is false at
 *     the project level. The whole canopy feature is off; nothing to map.
 *   - 'no_described_entries': canopy is on but no rows have llm_description
 *     yet (canopy-describe hasn't drained the queue). Map would be empty.
 *   - 'inputs_unchanged': the prior canopy_maps row's inputs_hash matches —
 *     idempotent re-fire, no work to do.
 *
 * `inputsHash` is only meaningful for 'inputs_unchanged' (the gate-style
 * skips short-circuit before the hash is computed).
 */
export type CanopyMapGatherSkip =
  | { skip: true; reason: 'canopy_disabled' | 'no_described_entries' }
  | { skip: true; reason: 'inputs_unchanged'; inputsHash: string };

/**
 * Internal — exported only so the canopy-map test suite can assemble the
 * exact gather context that the render-phase instruction sees.
 *
 * Two cheap up-front gates run before any hashing or rules-file IO:
 *   1. Canopy disabled at the project level → skip with no LLM cost.
 *   2. Zero described canopy_entries rows → skip; the map would be empty.
 * Both pair with the `schedule.enabled: true` default on canopy-map.yaml so
 * users with canopy off don't see scheduled runs.
 */
export async function gatherCanopyMapContext(
  projectRoot: string,
  forceColdStart: boolean,
  config?: MycoConfig,
): Promise<CanopyMapGatherContext | CanopyMapGatherSkip> {
  const vaultDir = `${projectRoot.replace(/\/$/, '')}/.myco`;
  const projectId = resolveRequestContextForVault(vaultDir).projectId;

  // Gate 1: canopy injection master switch. The schedule fires whenever the
  // task is enabled, so the gate must absorb the disabled-canopy case here.
  // Defaults to true when config is unavailable (legacy callers, tests),
  // so omitting the config doesn't accidentally hide work.
  if (config && !config.cortex.canopy.inject_on_pre_tool_use) {
    return { skip: true, reason: 'canopy_disabled' };
  }

  // Gate 2: empty described-row pool. A map with no rows would just be the
  // directory skeleton — pointless LLM work. Cheap COUNT, same predicate as
  // the SELECT below so the two can't disagree.
  if (countDescribedCanopyEntries(projectId) === 0) {
    return { skip: true, reason: 'no_described_entries' };
  }

  const canopyEntries = loadDescribedCanopyEntries(projectId);
  const rulesFiles = await loadRulesFiles(projectRoot);
  const inputsHash = computeInputsHash({
    canopyEntries,
    rulesFiles,
    promptVersion: MAP_TASK_PROMPT_VERSION,
  });

  // Prior map lookup is keyed (project_id, machine_id). The map is per-machine
  // because token_estimate and timing reflect how *this* machine ran the
  // task — sync between machines is a separate concern.
  const machineId = getMachineId(vaultDir);
  const prior = readCanopyMap(projectId, machineId);

  if (!forceColdStart && prior?.inputs_hash === inputsHash) {
    return { skip: true, reason: 'inputs_unchanged', inputsHash };
  }

  return {
    projectId,
    priorMap: forceColdStart ? null : prior,
    canopyEntries,
    rulesFiles,
    inputsHash,
    forceColdStart,
  };
}

function renderCanopyMapInstruction(ctx: CanopyMapGatherContext): string {
  const parts: string[] = [];

  parts.push('## Inputs (pre-assembled)');
  parts.push('');
  parts.push(`canopy_entries: ${ctx.canopyEntries.length} described file(s)`);
  parts.push(`rules_files: ${ctx.rulesFiles.length} file(s) — names only`);
  parts.push(`inputs_hash: ${ctx.inputsHash}`);
  parts.push(`force_cold_start: ${ctx.forceColdStart}`);
  parts.push('');

  if (ctx.priorMap) {
    parts.push('## Prior map (refine, do not rewrite from scratch)');
    parts.push('Preserve sections that still apply. Update sections whose');
    parts.push('underlying files have drifted. Remove clusters whose files');
    parts.push('no longer exist or no longer belong together.');
    parts.push('');
    parts.push('```markdown');
    parts.push(ctx.priorMap.content);
    parts.push('```');
    parts.push('');
  } else {
    parts.push('## No prior map — produce a fresh one');
    parts.push('');
  }

  parts.push('## Rules files (filenames only)');
  if (ctx.rulesFiles.length === 0) {
    parts.push('(none)');
  } else {
    for (const rf of ctx.rulesFiles) {
      parts.push(`- ${rf.filename}`);
    }
  }
  parts.push('');

  parts.push('## Canopy entries (path, content_hash, llm_description)');
  parts.push('');
  parts.push('```json');
  parts.push(JSON.stringify(ctx.canopyEntries, null, 2));
  parts.push('```');
  parts.push('');

  parts.push('When the map is ready, call vault_report({');
  parts.push('  action: "canopy_map",');
  parts.push('  summary: "<one short sentence on what changed vs. the prior map (or initial map)>",');
  parts.push('  details: { content: "<the final markdown>" }');
  parts.push('}). Stop after the report.');

  return parts.join('\n');
}

/**
 * Discriminated reasons buildCanopyMapInstructionDetailed surfaces when it
 * skips. Daemon callers translate these into a user-facing message; the
 * thin `buildCanopyMapInstruction` wrapper collapses them all to undefined
 * for the dispatcher path.
 */
export type CanopyMapBuildSkipReason =
  | 'no_project_root'
  | 'canopy_disabled'
  | 'no_described_entries'
  | 'inputs_unchanged';

export type CanopyMapBuildResult =
  | { kind: 'built'; instruction: string; context: TaskRunContext }
  | { kind: 'skip'; reason: CanopyMapBuildSkipReason };

/**
 * Detailed canopy-map build that preserves the skip reason. The daemon's
 * /canopy/map/regenerate path uses this directly so it can return a
 * structured "skipped" envelope to the UI instead of running the agent
 * with no instruction (which would succeed at the LLM phase but throw in
 * finalizeCanopyMap because runContext.canopy_map_inputs_hash is unset).
 *
 * Honors `force_cold_start` (boolean) param — when true, bypasses both
 * the inputs_hash short-circuit AND prior-map refinement, producing a
 * fresh map regardless of cached state.
 */
export async function buildCanopyMapInstructionDetailed(
  params?: Record<string, string | number | boolean>,
  projectRoot?: string,
  config?: MycoConfig,
): Promise<CanopyMapBuildResult> {
  if (!projectRoot) return { kind: 'skip', reason: 'no_project_root' };

  const forceColdStart = params?.force_cold_start === true;
  const ctx = await gatherCanopyMapContext(projectRoot, forceColdStart, config);

  if ('skip' in ctx) return { kind: 'skip', reason: ctx.reason };

  const instruction = renderCanopyMapInstruction(ctx);
  return {
    kind: 'built',
    instruction,
    context: { canopy_map_inputs_hash: ctx.inputsHash },
  };
}

/**
 * Build the instruction for a canopy-map run.
 *
 * Phase 1 (deterministic): gather canopy entries + rules files, compute
 * inputs_hash, short-circuit when the prior map is still current.
 *
 * Phase 2 (LLM): renderCanopyMapInstruction() produces the prompt the
 * render phase sees. The LLM emits the final markdown via vault_report
 * and finalizeOnTaskSuccess persists it to canopy_maps.
 *
 * Returns undefined when the detailed builder reports a skip — see
 * `buildCanopyMapInstructionDetailed` for the reasons. Dispatcher callers
 * combine this with `isInstructionRequiredTask` to skip the run cleanly.
 */
export async function buildCanopyMapInstruction(
  params?: Record<string, string | number | boolean>,
  projectRoot?: string,
  config?: MycoConfig,
): Promise<BuiltTaskInstruction | undefined> {
  const result = await buildCanopyMapInstructionDetailed(params, projectRoot, config);
  return result.kind === 'built'
    ? { instruction: result.instruction, context: result.context }
    : undefined;
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
  requestContext?: MycoRequestContext,
): Promise<BuiltTaskInstruction | undefined> {
  switch (taskName) {
    case SKILL_GENERATE_TASK:
      return buildSkillGenerateInstruction(requestContext);
    case SKILL_SURVEY_TASK:
      return agentId ? buildSkillSurveyInstruction(agentId, requestContext) : undefined;
    case SKILL_EVOLVE_TASK: {
      const instruction = await buildSkillEvolveInstruction(taskParams, projectRoot, retrievalProvider, requestContext);
      return instruction ? { instruction } : undefined;
    }
    case CORTEX_INSTRUCTIONS_TASK: {
      if (!config || !projectRoot) return undefined;
      const vaultDir = `${projectRoot.replace(/\/$/, '')}/.myco`;
      const built = await buildScheduledCortexInstruction(config, vaultDir, getTeamClient, requestContext);
      return built
        ? {
            instruction: built.instruction,
            context: { cortex_instruction_input_hash: built.inputHash },
          }
        : undefined;
    }
    case CANOPY_DESCRIBE_TASK:
      // Map-phase task — no instruction text; phase reads params via templating.
      return undefined;
    case CANOPY_MAP_TASK:
      return buildCanopyMapInstruction(taskParams, projectRoot, config);
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
    || taskName === CORTEX_INSTRUCTIONS_TASK
    || taskName === CANOPY_MAP_TASK;
}
