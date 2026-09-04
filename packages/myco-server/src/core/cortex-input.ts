/**
 * The input a `cortex-instructions` run is handed, built by the server.
 *
 * 1.4 assembled this against a local vault (`packages/myco/src/context/cortex-brief.ts`).
 * A dispatched run holds no vault, so the Deployment builds the payload and
 * carries it on the run row as the run's instruction. The material and its
 * limits are 1.4's: five recent sessions with title and summary previews, three
 * spores of each of the three synthesized kinds, three active plans, and an
 * excerpt of the digest at the tier Settings prefers.
 *
 * **This module issues no SQL of its own.** Every read goes through the read
 * layer and the core stores that already own these tables, so a scope rule or a
 * gate fixed there reaches this payload too.
 *
 * **The hash covers the input, never the clock.** `inputHash` is taken over the
 * leaves, the Project's capabilities, the served tool names, the authoring
 * contract, and the material's ids and content previews. A timestamp inside it
 * would make every build differ and turn the dedup that keeps a daily run from
 * spending dollars on unchanged material into a no-op.
 */
import type { RelationalStore } from './adapters.js';
import { digestForTier, listDigests } from './digests.js';
import { listSpores } from './spores.js';
import type { RecallLeaves } from './recall.js';
import type { ProjectCapability } from './settings.js';
import { SERVED_TOOLS } from './tool-catalogue.js';
import { TOOL_DEFINITIONS } from '../mcp/definitions.js';
import { listProjectPlans } from '../read/plans.js';
import { listSessions } from '../read/sessions.js';
import type { ReadScope } from '../read/scope.js';
import { sha256Hex } from '../hash.js';

/** How many settled sessions the payload carries. */
export const RECENT_SESSION_LIMIT = 5;
/** How many spores of each synthesized kind the payload carries. */
export const RECENT_WISDOM_SPORE_LIMIT = 3;
export const RECENT_DECISION_SPORE_LIMIT = 3;
export const RECENT_DISCOVERY_SPORE_LIMIT = 3;
/** How many active plans the payload carries. */
export const RECENT_PLAN_LIMIT = 3;
/** How much of one body a preview carries, cut on a word boundary. */
export const CONTENT_PREVIEW_MAX_CHARS = 360;
/** How much of the preferred digest the payload carries. */
export const DIGEST_EXCERPT_MAX_CHARS = 1800;
/** Indentation of the runtime config block the payload renders. */
const JSON_INDENT = 2;

/**
 * The authoring contract version.
 *
 * The authoring requirements are not hashed — they embed per-build material —
 * so a change to what the artifact must say bumps this instead, and every
 * Project rebuilds its instructions once.
 */
export const PROMPT_CONTRACT = 3;

export const CORTEX_SKILLS_NOTE = 'Project and Myco skills are already registered with the agent separately. Tell the agent to use the `myco` skill as the fuller workflow reference for design decisions, non-obvious debugging, prior-project context, plan work, durable knowledge capture, and delegation; keep the explicit tool guidance as the compact always-on version of that workflow. Do not instruct it to call `myco_skills`.';

/** Tool names 1.4 retired. A preview naming one is rewritten before it reaches the model. */
export const RETIRED_TOOL_NAMES = [
  'canopy_map',
  'myco_context',
  'myco_recall',
  'myco_remember',
  'myco_save_plan',
  'myco_runs',
  'myco_supersede',
  'myco_consolidate',
] as const;

export const RETIRED_TOOLS_NOTE = 'Do not mention retired tool names, even as gotchas or historical context. If recent vault context mentions an obsolete name, translate it to the current owning tool from the tool guidance instead.';

const RETIRED_TOOL_PLACEHOLDER = '[retired Myco tool]';
const RETIRED_TOOL_REFERENCE_PATTERN = new RegExp(
  RETIRED_TOOL_NAMES.map((tool) => tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

/** What one build answers: the prompt the run receives, the hash of its material, and what the material counted. */
export interface InstructionsInput {
  instruction: string;
  inputHash: string;
  counts: InstructionsCounts;
}

export interface InstructionsCounts extends Readonly<Record<string, number>> {
  sessions: number;
  spores: number;
  plans: number;
}

/** What the build is told beyond the store: the Deployment's recall leaves, the Project's capabilities, and the instant it runs at. */
export interface InstructionsInputOptions {
  leaves: RecallLeaves;
  capabilities: Readonly<Record<ProjectCapability, boolean>>;
  now: number;
}

/** A body cut to `maxChars` on a word boundary, with retired tool names rewritten. */
export function preview(text: string | null, maxChars: number = CONTENT_PREVIEW_MAX_CHARS): string | null {
  if (text === null || text === '') return null;
  const sanitized = text
    .replace(RETIRED_TOOL_REFERENCE_PATTERN, RETIRED_TOOL_PLACEHOLDER)
    .replace(/\[retired Myco tool\]\(\)/g, RETIRED_TOOL_PLACEHOLDER);
  if (sanitized.length <= maxChars) return sanitized;
  const cut = sanitized.slice(0, maxChars);
  const boundary = sanitized[maxChars] === ' ' ? maxChars : cut.lastIndexOf(' ');
  return `${(boundary > maxChars / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The tools this Deployment serves, in the order the definitions declare them. */
function servedToolNames(): string[] {
  return TOOL_DEFINITIONS.filter((tool) => (SERVED_TOOLS as readonly string[]).includes(tool.name)).map((tool) => tool.name);
}

/** One line per served tool, the guidance the artifact must encode, highest signal first. */
function retrievalGuidanceLines(): string[] {
  return TOOL_DEFINITIONS
    .filter((tool) => (SERVED_TOOLS as readonly string[]).includes(tool.name) && tool.cortex !== undefined)
    .map((tool) => ({ name: tool.name, guidance: tool.cortex!.guidance, priority: tool.cortex!.priority ?? 100 }))
    .sort((left, right) => left.priority - right.priority)
    .map((entry) => `- \`${entry.name}\`: ${entry.guidance}`);
}

function capabilitySummary(): string[] {
  return [
    'Myco can retrieve project knowledge for this project.',
    'Use the currently available Myco tool surfaces described below, and omit any surfaces that are offline.',
  ];
}

/** The material one build read, kept apart from its rendering so the hash covers the facts rather than the prose. */
interface Material {
  sessions: Array<{ id: string; label: string; branch: string | null; summary: string | null }>;
  wisdom: Array<{ id: string; sessionId: string | null; content: string | null }>;
  decision: Array<{ id: string; sessionId: string | null; content: string | null }>;
  discovery: Array<{ id: string; sessionId: string | null; content: string | null }>;
  plans: Array<{ key: string; title: string; status: string; content: string | null }>;
  digest: { tier: number; excerpt: string } | null;
}

const EMPTY_SESSIONS = 'No recent sessions are available.';
const EMPTY_PLANS = 'No active plans are available.';
const EMPTY_DIGEST = 'No current digest extract is available.';

function renderSessions(material: Material): string {
  if (material.sessions.length === 0) return EMPTY_SESSIONS;
  return material.sessions.map((session) => {
    const head = `- ${session.label}${session.branch === null ? '' : ` (branch=${session.branch})`}`;
    return session.summary === null ? head : `${head}\n  ${session.summary}`;
  }).join('\n');
}

function renderSpores(rows: Material['wisdom'], kind: string): string {
  if (rows.length === 0) return `No recent ${kind} spores are available.`;
  return rows.map((spore) => [
    `- ${spore.content ?? ''}`,
    spore.sessionId === null ? null : `session=${spore.sessionId}`,
  ].filter((part): part is string => part !== null).join(' — ')).join('\n');
}

function renderPlans(material: Material): string {
  if (material.plans.length === 0) return EMPTY_PLANS;
  return material.plans.map((plan) => [
    `- ${plan.title}`,
    `status=${plan.status}`,
    plan.content,
  ].filter((part): part is string => part !== null && part !== '').join(' — ')).join('\n');
}

function renderDigest(material: Material): string {
  if (material.digest === null) return EMPTY_DIGEST;
  return material.digest.excerpt === ''
    ? `Tier ${material.digest.tier} digest extract is empty.`
    : `Tier ${material.digest.tier} digest excerpt:\n${material.digest.excerpt}`;
}

/** The runtime config block the artifact is told to honour: the seven cortex leaves as recall resolves them, and whether the Project holds the capability. */
function runtimeConfig(options: InstructionsInputOptions): Record<string, unknown> {
  return {
    enabled: options.capabilities.cortex,
    instructions_inject_on_session_start: options.leaves.instructionsAtSessionStart,
    instructions_inject_on_subagent_start: options.leaves.instructionsAtSubagentStart,
    digest_tier: options.leaves.digestTier,
    digest_inject_on_session_start: options.leaves.digestAtSessionStart,
    plans_inject_intent_nudge_on_prompt_submit: options.leaves.planNudge,
    spores_inject_on_prompt_submit: options.leaves.injection.enabled,
    spores_max_per_prompt: options.leaves.injection.maxPerPrompt,
  };
}

/** The authoring requirements the artifact is held to. Carried from 1.4, minus the guidance for surfaces this Deployment does not serve. */
function authoringRequirements(): string[] {
  return [
    '- Start with the heading `## Myco-Enabled Project`.',
    '- Follow the heading with one brief sentence explaining that Myco provides project memory, prior decisions, plans, and retrieval tools for this repository.',
    '- Teach the most useful current Myco tool behavior, especially retrieval and plan persistence. Name tools only (e.g. `myco_cortex`, `myco_plans`) — never shell command syntax; the host injects its own transport directive with the correct invocation for this machine.',
    '- Treat "Current valid tool surface" and "Tool guidance to encode" below as authoritative. Recent sessions, spores, or digest excerpts may contain obsolete tool names; do not copy obsolete names into the final instructions.',
    '- Use the recent vault activity below to mention live project hotspots when that improves usefulness.',
    '- Do not introduce additional tool calls inside recent-workstream prose. Only name tool operations that appear in "Tool guidance to encode" or in the required plan-persistence, delegation, and spore-save guidance; never invent extra `myco_cortex` ops from recent context.',
    `- ${CORTEX_SKILLS_NOTE}`,
    `- ${RETIRED_TOOLS_NOTE}`,
    '- Keep the heading and description brief so most of the budget goes to retrieval guidance.',
    '- Keep the output compact and ready for direct injection.',
    '- In the planning paragraph, teach `myco_cortex` op `"digest"` as the explicit, optional high-fidelity memory pull for large refactors, large features, broad planning, or unfamiliar cross-system changes. Recommend `myco_cortex({"op":"digest","tier":5000})` by default, and tier 10000 only when the agent has enough context budget and needs deeper historical background. Say not to pull the digest for narrow edits.',
    '- Include one delegation sentence: when composing a child-agent, subagent, teammate, worker session, or other spawned process prompt, and Myco has not already injected subagent-start Cortex context, tell the agent to refresh the current project instructions with `myco_cortex({"op":"instructions"})` and include the returned instructions verbatim in that agent\'s prompt, along with task-specific instructions. Do not assume the returned instructions have any particular heading or section name.',
    '- When you mention recent plans, label the section "Recent plans" or "Recent workstreams" (NOT "Current workstreams" — that implies the new session is going to work on them). Treat them as background: prior or in-flight work the agent should be aware of when its actual task happens to overlap, not a directive to engage.',
  ];
}

/** Everything the payload reads, through the stores that own it. */
async function readMaterial(db: RelationalStore, scope: ReadScope, options: InstructionsInputOptions): Promise<Material> {
  const [sessions, wisdom, decision, discovery, plans, digests] = await Promise.all([
    listSessions(db, scope, { limit: RECENT_SESSION_LIMIT, state: 'ended' }),
    listSpores(db, scope, { observationType: 'wisdom', status: 'active', includeActive: false, limit: RECENT_WISDOM_SPORE_LIMIT }),
    listSpores(db, scope, { observationType: 'decision', status: 'active', includeActive: false, limit: RECENT_DECISION_SPORE_LIMIT }),
    listSpores(db, scope, { observationType: 'discovery', status: 'active', includeActive: false, limit: RECENT_DISCOVERY_SPORE_LIMIT }),
    listProjectPlans(db, scope, { status: 'active', limit: RECENT_PLAN_LIMIT }),
    listDigests(db, scope),
  ]);
  const chosen = digestForTier(digests, options.leaves.digestTier);
  const asSpore = (row: { id: string; sessionId: string | null; content: string }) => ({ id: row.id, sessionId: row.sessionId, content: preview(row.content) });
  return {
    sessions: sessions.rows.map((row) => ({ id: row.sessionId, label: row.label, branch: row.branch, summary: preview(row.summary) })),
    wisdom: wisdom.map(asSpore),
    decision: decision.map(asSpore),
    discovery: discovery.map(asSpore),
    plans: plans.map((plan) => ({ key: plan.planKey, title: plan.title ?? plan.planKey, status: plan.status, content: preview(plan.content) })),
    digest: chosen === null ? null : { tier: chosen.row.tier, excerpt: preview(chosen.row.content, DIGEST_EXCERPT_MAX_CHARS) ?? '' },
  };
}

/**
 * The bytes the hash is taken over.
 *
 * Every field here is a fact about the input: what the Deployment is configured
 * to serve, what it serves it with, and what the Project holds. Nothing here
 * moves on its own between two builds over the same material.
 */
function hashedInput(material: Material, options: InstructionsInputOptions, servedTools: readonly string[]): string {
  return JSON.stringify({
    promptContract: PROMPT_CONTRACT,
    cortex: runtimeConfig(options),
    capabilities: Object.fromEntries(Object.entries(options.capabilities).sort(([a], [b]) => (a < b ? -1 : 1))),
    servedTools,
    sessions: material.sessions,
    wisdom: material.wisdom,
    decision: material.decision,
    discovery: material.discovery,
    plans: material.plans,
    digest: material.digest,
  });
}

/**
 * Build the instruction a `cortex-instructions` run receives, and the hash of
 * the material behind it.
 *
 * The hash is what a second dispatch compares against the row the last run
 * wrote: equal means the Project has not moved, and the dispatch is answered
 * `unchanged` with no run started.
 */
export async function buildInstructionsInput(
  db: RelationalStore,
  scope: ReadScope,
  options: InstructionsInputOptions,
): Promise<InstructionsInput> {
  const material = await readMaterial(db, scope, options);
  const servedTools = servedToolNames();

  const parts = [
    'Author compact session-start instructions for another coding agent.',
    'Focus on teaching how to use the highest-signal Myco tools correctly, especially retrieval and plan persistence.',
    'Do not restate AGENTS.md or static installation details.',
    '',
    '## Runtime config',
    JSON.stringify(runtimeConfig(options), null, JSON_INDENT),
    '',
    '## Authoring requirements',
    ...authoringRequirements(),
    '',
    '## Capability summary',
    ...capabilitySummary(),
    '',
    '## Current valid tool surface (authoritative)',
    `Project tools: ${servedTools.map((name) => `\`${name}\``).join(', ')}.`,
    '',
    '## Tool guidance to encode',
    ...retrievalGuidanceLines(),
    '',
    '## Current digest excerpt',
    renderDigest(material),
    '',
    '## Recent sessions',
    renderSessions(material),
    '',
    '## Recent wisdom spores',
    renderSpores(material.wisdom, 'wisdom'),
    '',
    '## Recent decision spores',
    renderSpores(material.decision, 'decision'),
    '',
    '## Recent discovery spores',
    renderSpores(material.discovery, 'discovery'),
    '',
    '## Recent plans (background context — not a task list for this session)',
    renderPlans(material),
  ];

  return {
    instruction: parts.join('\n'),
    inputHash: await sha256Hex(hashedInput(material, options, servedTools)),
    counts: {
      sessions: material.sessions.length,
      spores: material.wisdom.length + material.decision.length + material.discovery.length,
      plans: material.plans.length,
    },
  };
}
