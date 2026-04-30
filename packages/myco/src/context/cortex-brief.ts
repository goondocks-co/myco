/**
 * Cortex content assembly.
 *
 * Builds the material that the Cortex agent consumes and emits:
 *   - Capability resolution (team/collective availability)
 *   - Delivery-decision logic (inline vs session-start injection)
 *   - Retrieval guidance derived from MCP tool definitions
 *   - Instruction-input prompt for the `cortex-instructions` agent task
 *
 * Pure content layer — orchestration (agent run launch, snapshot reads,
 * prompt builder) lives in `@myco/daemon/cortex`.
 */
import { createHash } from 'node:crypto';
import type { MycoConfig } from '@myco/config/schema.js';
import {
  CONTENT_HASH_ALGORITHM,
  DEFAULT_AGENT_ID,
  DIGEST_FALLBACK_TIER,
} from '@myco/constants.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { listSpores } from '@myco/db/queries/spores.js';
import { readCanopyMap } from '@myco/canopy/map/store.js';
import { resolveCanopyProjectId } from '@myco/canopy/identity.js';
import { getMachineId } from '@myco/daemon/machine-id.js';
import type { TeamSyncClient } from '../daemon/team-sync.js';
import {
  TOOL_DEFINITIONS,
  COLLECTIVE_TOOL_DEFINITIONS,
  getToolCortexPriority,
  type ToolDefinition,
} from '../tools/definitions.js';

const MAX_COLLECTIVE_CAPABILITY_LABELS = 4;
const ALL_CORTEX_TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS];

const RECENT_SESSION_LIMIT = 5;
const RECENT_WISDOM_SPORE_LIMIT = 3;
const RECENT_DECISION_SPORE_LIMIT = 3;
const RECENT_DISCOVERY_SPORE_LIMIT = 3;
const RECENT_PLAN_LIMIT = 3;
const CONTENT_PREVIEW_MAX_CHARS = 360;
const DIGEST_EXCERPT_MAX_CHARS = 1800;
const JSON_INDENT = 2;

export const CORTEX_SKILLS_NOTE = 'Project and Myco skills are already registered with the agent separately. Tell the agent to use those skills directly when relevant, and do not instruct it to call `myco_skills`.';
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
const RETIRED_TOOLS_NOTE = 'Do not mention retired tool names, even as gotchas or historical context. If recent vault context mentions an obsolete name, translate it to the current owning tool from the tool guidance instead.';
const RETIRED_TOOL_REFERENCE_PATTERN = new RegExp(
  RETIRED_TOOL_NAMES.map((tool) => tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

export interface CortexCapabilities {
  teamEnabled: boolean;
  collectiveConnected: boolean;
  collectiveCapabilities: string[];
}

export interface CortexToolGuidance {
  tool: string;
  guidance: string;
  requiresTeam?: boolean;
  requiresCollective?: boolean;
  priority: number;
}

export interface DeliveryDecision {
  inlineInstructions: boolean;
  reason: 'missing-symbiont' | 'session-start-supported' | 'session-start-disabled' | 'no-session-start';
}

function toCortexToolGuidance(
  tool: Pick<ToolDefinition, 'name' | 'cortex'>,
): CortexToolGuidance | null {
  const cortex = tool.cortex;
  if (!cortex) return null;
  return {
    tool: tool.name,
    guidance: cortex.guidance,
    requiresTeam: cortex.requiresTeam,
    requiresCollective: cortex.requiresCollective,
    priority: getToolCortexPriority(tool),
  };
}

export const RETRIEVAL_GUIDANCE: CortexToolGuidance[] = ALL_CORTEX_TOOL_DEFINITIONS
  .map(toCortexToolGuidance)
  .filter((entry): entry is CortexToolGuidance => entry !== null)
  .sort((left, right) => left.priority - right.priority);

export async function resolveCortexCapabilities(
  config: Pick<MycoConfig, 'team'>,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<CortexCapabilities> {
  const teamClient = getTeamClient?.() ?? null;
  const teamEnabled = Boolean(config.team.enabled && teamClient);
  let collectiveConnected = false;
  let collectiveCapabilities: string[] = [];

  if (teamEnabled && teamClient) {
    try {
      const status = await teamClient.getCollectiveStatus();
      collectiveConnected = Boolean(status?.connected);
      collectiveCapabilities = status?.capabilities ?? [];
    } catch {
      collectiveConnected = false;
      collectiveCapabilities = [];
    }
  }

  return {
    teamEnabled,
    collectiveConnected,
    collectiveCapabilities,
  };
}

/**
 * Whether Cortex should inject session-start instructions for this
 * config. Combines the Cortex master-kill with the per-event toggle.
 */
export function shouldInjectCortex(cortex: MycoConfig['cortex']): boolean {
  return cortex.enabled && cortex.instructions.inject_on_session_start;
}

export function resolveInstructionDelivery(
  cortex: MycoConfig['cortex'],
  symbiont: {
    supportsSessionStartInjection: boolean;
  } | null,
): DeliveryDecision {
  if (!symbiont) {
    return { inlineInstructions: true, reason: 'missing-symbiont' };
  }
  if (!shouldInjectCortex(cortex)) {
    return { inlineInstructions: true, reason: 'session-start-disabled' };
  }
  if (symbiont.supportsSessionStartInjection) {
    return { inlineInstructions: false, reason: 'session-start-supported' };
  }
  return { inlineInstructions: true, reason: 'no-session-start' };
}

export function buildCapabilitySummary(capabilities: CortexCapabilities): string[] {
  const summary = [
    capabilities.collectiveConnected
      ? 'Myco can retrieve local, team, and collective knowledge in this project.'
      : capabilities.teamEnabled
        ? 'Myco can retrieve local and shared team knowledge in this project.'
        : 'Myco can retrieve local project knowledge in this project.',
    'Use the currently available Myco tool surfaces described below, preferring CLI JSON when MCP is unavailable or brittle, and omit any surfaces that are offline.',
  ];

  if (capabilities.collectiveConnected && capabilities.collectiveCapabilities.length > 0) {
    const labels = capabilities.collectiveCapabilities.slice(0, MAX_COLLECTIVE_CAPABILITY_LABELS);
    const remaining = Math.max(
      0,
      capabilities.collectiveCapabilities.length - MAX_COLLECTIVE_CAPABILITY_LABELS,
    );
    const suffix = remaining > 0 ? ` (+${remaining} more)` : '';
    summary.push(`Collective capabilities online: ${labels.join(', ')}${suffix}.`);
  }

  return summary;
}

export function buildRetrievalGuidanceLines(capabilities: CortexCapabilities): string[] {
  const lines: string[] = [];

  for (const entry of RETRIEVAL_GUIDANCE) {
    if (entry.requiresTeam && !capabilities.teamEnabled) continue;
    if (entry.requiresCollective && !capabilities.collectiveConnected) continue;
    lines.push(`- \`${entry.tool}\`: ${entry.guidance}`);
  }

  return lines;
}

function buildCurrentToolSurfaceLines(capabilities: CortexCapabilities): string[] {
  const lines = [
    `Local project tools: ${TOOL_DEFINITIONS.map((tool) => `\`${tool.name}\``).join(', ')}.`,
  ];

  if (capabilities.collectiveConnected) {
    lines.push(`Collective tools: ${COLLECTIVE_TOOL_DEFINITIONS.map((tool) => `\`${tool.name}\``).join(', ')}.`);
  } else {
    lines.push('Collective tools are offline in this session; do not mention them unless the capability summary says Collective is connected.');
  }

  return lines;
}

// ---------------------------------------------------------------------------
// Instruction-input prompt assembly (for the `cortex-instructions` task)
// ---------------------------------------------------------------------------

function hashInput(value: unknown): string {
  return createHash(CONTENT_HASH_ALGORITHM)
    .update(JSON.stringify(value))
    .digest('hex');
}

function truncatePreview(text: string | null, maxChars: number = CONTENT_PREVIEW_MAX_CHARS): string | null {
  if (!text) return null;
  const sanitized = text
    .replace(RETIRED_TOOL_REFERENCE_PATTERN, '[retired Myco tool]')
    .replace(/\[retired Myco tool\]\(\)/g, '[retired Myco tool]');
  return sanitized.length > maxChars
    ? `${sanitized.slice(0, maxChars)}...`
    : sanitized;
}

function formatRecentSessions(): string {
  const sessions = listSessions({
    includeActive: false,
    limit: RECENT_SESSION_LIMIT,
  });
  if (sessions.length === 0) return 'No recent sessions are available.';

  return sessions.map((session) => {
    const head = `- ${session.title ?? session.id}${session.branch ? ` (branch=${session.branch})` : ''}`;
    const body = truncatePreview(session.summary);
    return body ? `${head}\n  ${body}` : head;
  }).join('\n');
}

function formatSporesOfType(
  observationType: 'wisdom' | 'decision' | 'discovery',
  limit: number,
): string {
  const spores = listSpores({
    observation_type: observationType,
    includeActive: false,
    status: 'active',
    limit,
  });
  if (spores.length === 0) return `No recent ${observationType} spores are available.`;

  return spores.map((spore) => {
    const parts = [
      `- ${truncatePreview(spore.content)}`,
      spore.session_id ? `session=${spore.session_id}` : null,
    ].filter(Boolean);
    return parts.join(' — ');
  }).join('\n');
}

function formatRecentPlans(): string {
  const plans = listPlans({
    status: 'active',
    limit: RECENT_PLAN_LIMIT,
  });
  if (plans.length === 0) return 'No active plans are available.';

  return plans.map((plan) => {
    const parts = [
      `- ${plan.title ?? plan.id}`,
      `status=${plan.status}`,
      truncatePreview(plan.content),
    ].filter(Boolean);
    return parts.join(' — ');
  }).join('\n');
}

function formatDigestExcerpt(config: MycoConfig): string {
  const preferredTier = config.cortex.digest.tier;
  const extract =
    getDigestExtract(DEFAULT_AGENT_ID, preferredTier) ??
    getDigestExtract(DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER);
  if (!extract) return 'No current digest extract is available.';

  const excerpt = truncatePreview(extract.content, DIGEST_EXCERPT_MAX_CHARS) ?? '';
  return excerpt
    ? `Tier ${extract.tier} digest excerpt:\n${excerpt}`
    : `Tier ${extract.tier} digest extract is empty.`;
}

export interface CortexInstructionPayload {
  inputHash: string;
  instruction: string;
}

export async function buildCortexInstructionsInput(
  config: MycoConfig,
  vaultDir: string,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<CortexInstructionPayload> {
  // Probe the Canopy Map state once at build time so the prompt can branch
  // deterministically. We only emit the myco_cortex canopy_map directive when a
  // populated map exists for this project — that way agents downstream
  // never see guidance for a tool that would return empty. The chain
  // also covers describe state implicitly: the map task can't produce a
  // non-empty row without described files, so a populated map proves
  // canopy-describe has run successfully.
  const projectId = resolveCanopyProjectId(vaultDir);
  const machineId = getMachineId(vaultDir);
  const mapRow = readCanopyMap(projectId, machineId);
  const hasCanopyMap = !!(mapRow && mapRow.content && mapRow.content.length > 0);

  const capabilities = await resolveCortexCapabilities(config, getTeamClient);
  const capabilitySummary = buildCapabilitySummary(capabilities);
  const currentToolSurface = buildCurrentToolSurfaceLines(capabilities);
  const retrievalGuidance = buildRetrievalGuidanceLines(capabilities);
  const recentSessions = formatRecentSessions();
  const recentWisdomSpores = formatSporesOfType('wisdom', RECENT_WISDOM_SPORE_LIMIT);
  const recentDecisionSpores = formatSporesOfType('decision', RECENT_DECISION_SPORE_LIMIT);
  const recentDiscoverySpores = formatSporesOfType('discovery', RECENT_DISCOVERY_SPORE_LIMIT);
  const recentPlans = formatRecentPlans();
  const digestExcerpt = formatDigestExcerpt(config);
  const input = {
    cortex: {
      enabled: config.cortex.enabled,
      instructions_inject_on_session_start: config.cortex.instructions.inject_on_session_start,
      digest_tier: config.cortex.digest.tier,
      digest_inject_on_session_start: config.cortex.digest.inject_on_session_start,
      spores_inject_on_prompt_submit: config.cortex.spores.inject_on_prompt_submit,
      spores_max_per_prompt: config.cortex.spores.max_per_prompt,
    },
    capabilities,
    toolSurface: {
      currentToolSurface,
      retrievalGuidance,
      retiredToolNames: RETIRED_TOOL_NAMES,
      skillsNote: CORTEX_SKILLS_NOTE,
      retiredToolsNote: RETIRED_TOOLS_NOTE,
    },
    digestExcerpt,
    recentSessions,
    recentWisdomSpores,
    recentDecisionSpores,
    recentDiscoverySpores,
    recentPlans,
  };

  const instructionParts = [
    'Author compact session-start instructions for another coding agent.',
    'Focus on teaching how to use the highest-signal Myco tools correctly, especially retrieval and plan persistence.',
    'Do not restate AGENTS.md or static installation details.',
    '',
    '## Runtime config',
    JSON.stringify(input.cortex, null, JSON_INDENT),
    '',
    '## Authoring requirements',
    '- Start with the heading `## Myco-Enabled Project`.',
    '- Follow the heading with one brief sentence explaining that Myco provides project memory, prior decisions, plans, and retrieval tools for this repository.',
    '- Teach the most useful current Myco tool behavior, especially retrieval and plan persistence. Prefer the project-resolved CLI JSON launcher (`node .agents/myco-cli.cjs tool ...`) as the portable fallback and describe MCP as available when the host exposes it cleanly.',
    '- Treat "Current valid tool surface" and "Tool guidance to encode" below as authoritative. Recent sessions, spores, or digest excerpts may contain obsolete tool names; do not copy obsolete names into the final instructions.',
    '- Use the recent vault activity below to mention live project hotspots when that improves usefulness.',
    `- ${CORTEX_SKILLS_NOTE}`,
    `- ${RETIRED_TOOLS_NOTE}`,
    '- Keep the heading and description brief so most of the budget goes to retrieval guidance.',
    '- Keep the output compact and ready for direct injection.',
    // The recent-plans section is background context, not a task list for
    // the incoming session. The session is launching to do something else;
    // these plans tell the agent what shape of work the project has on file
    // so it can avoid duplicating effort or contradicting in-flight work.
    // Frame the section accordingly — never imply the new agent should
    // pick these plans up.
    '- When you mention recent plans, label the section "Recent plans" or "Recent workstreams" (NOT "Current workstreams" — that implies the new session is going to work on them). Treat them as background: prior or in-flight work the agent should be aware of when its actual task happens to overlap, not a directive to engage.',
  ];

  if (shouldInjectCortex(config.cortex) && hasCanopyMap) {
    // Emitted only when a non-empty Canopy Map exists for this project.
    // That gate makes the directive trustworthy unconditionally — there
    // is no empty-state caveat to hedge with — so the generated downstream
    // copy can be a default action rather than a conditional. If the map
    // is missing or empty, this directive is omitted entirely and the
    // session-start instructions stay silent about Canopy map retrieval.
    instructionParts.push(
      '- Teach `myco_cortex` op `"canopy_map"` as the default opener for any task that needs project layout — finding a feature, locating the right file before editing, or orienting in this codebase. Prefer the project-resolved CLI JSON path (`node .agents/myco-cli.cjs tool call myco_cortex --json --input \'{"op":"canopy_map"}\'`); use `myco_cortex({"op":"canopy_map"})` via MCP when the host exposes Myco tools cleanly. The map exists for this project right now and is built from real per-file descriptions (project-curated, not LLM guesses), and typically replaces a chain of Glob/Read calls before the agent has any signal about layout. Frame it as a default action, not a condition the agent can self-evaluate away. Do not add an empty-state caveat — this guidance is only injected when the map is populated.',
    );
  }

  instructionParts.push(
    '',
    '## Capability summary',
    ...capabilitySummary,
    '',
    '## Current valid tool surface (authoritative)',
    ...currentToolSurface,
    '',
    '## Tool guidance to encode',
    ...retrievalGuidance,
    '',
    '## Current digest excerpt',
    digestExcerpt,
    '',
    '## Recent sessions',
    recentSessions,
    '',
    '## Recent wisdom spores',
    recentWisdomSpores,
    '',
    '## Recent decision spores',
    recentDecisionSpores,
    '',
    '## Recent discovery spores',
    recentDiscoverySpores,
    '',
    '## Recent plans (background context — not a task list for this session)',
    recentPlans,
  );

  return {
    inputHash: hashInput(input),
    instruction: instructionParts.join('\n'),
  };
}

export async function buildScheduledCortexInstruction(
  config: MycoConfig,
  vaultDir: string,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<CortexInstructionPayload | undefined> {
  const built = await buildCortexInstructionsInput(config, vaultDir, getTeamClient);
  const existing = getCortexInstructions(DEFAULT_AGENT_ID);
  if (existing?.input_hash === built.inputHash) {
    return undefined;
  }
  return built;
}
