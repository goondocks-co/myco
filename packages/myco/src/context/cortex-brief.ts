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
} from '../mcp/tool-definitions.js';

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

export function shouldInjectCortex(
  config: MycoConfig['context'],
): boolean {
  return config.cortex_enabled;
}

export function resolveInstructionDelivery(
  config: MycoConfig['context'],
  symbiont: {
    supportsSessionStartInjection: boolean;
  } | null,
): DeliveryDecision {
  if (!symbiont) {
    return { inlineInstructions: true, reason: 'missing-symbiont' };
  }
  if (!config.cortex_enabled) {
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
    'Use only the currently available Myco MCP tools described below, and omit any surfaces that are offline.',
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
  return text.length > maxChars
    ? `${text.slice(0, maxChars)}...`
    : text;
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
  const preferredTier = config.context.digest_tier;
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
  // deterministically. We only emit the canopy_map() directive when a
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
  const retrievalGuidance = buildRetrievalGuidanceLines(capabilities);
  const recentSessions = formatRecentSessions();
  const recentWisdomSpores = formatSporesOfType('wisdom', RECENT_WISDOM_SPORE_LIMIT);
  const recentDecisionSpores = formatSporesOfType('decision', RECENT_DECISION_SPORE_LIMIT);
  const recentDiscoverySpores = formatSporesOfType('discovery', RECENT_DISCOVERY_SPORE_LIMIT);
  const recentPlans = formatRecentPlans();
  const digestExcerpt = formatDigestExcerpt(config);
  const input = {
    context: {
      digest_tier: config.context.digest_tier,
      cortex_enabled: config.context.cortex_enabled,
      prompt_search: config.context.prompt_search,
      prompt_max_spores: config.context.prompt_max_spores,
    },
    capabilities,
    digestExcerpt,
    recentSessions,
    recentWisdomSpores,
    recentDecisionSpores,
    recentDiscoverySpores,
    recentPlans,
    skillsNote: CORTEX_SKILLS_NOTE,
  };

  const instructionParts = [
    'Author compact session-start instructions for another coding agent.',
    'Focus on teaching how to use the highest-signal Myco tools correctly, especially retrieval and plan persistence.',
    'Do not restate AGENTS.md or static installation details.',
    '',
    '## Runtime config',
    JSON.stringify(input.context, null, JSON_INDENT),
    '',
    '## Authoring requirements',
    '- Start with the heading `## Myco-Enabled Project`.',
    '- Follow the heading with one brief sentence explaining that Myco provides project memory, prior decisions, plans, and retrieval tools for this repository.',
    '- Teach the most useful current Myco MCP tool behavior, especially retrieval and plan persistence.',
    '- Use the recent vault activity below to mention live project hotspots when that improves usefulness.',
    `- ${CORTEX_SKILLS_NOTE}`,
    '- Keep the heading and description brief so most of the budget goes to retrieval guidance.',
    '- Keep the output compact and ready for direct injection.',
  ];

  if (input.context.cortex_enabled && hasCanopyMap) {
    // Emitted only when a non-empty Canopy Map exists for this project.
    // That gate makes the directive trustworthy unconditionally — there
    // is no empty-state caveat to hedge with — so the generated downstream
    // copy can be a default action rather than a conditional. If the map
    // is missing or empty, this directive is omitted entirely and the
    // session-start instructions stay silent about canopy_map().
    instructionParts.push(
      '- Teach `canopy_map()` as the default opener for any task that needs project layout — finding a feature, locating the right file before editing, or orienting in this codebase. The map exists for this project right now and is built from real per-file descriptions (project-curated, not LLM guesses), and typically replaces a chain of Glob/Read calls before the agent has any signal about layout. Frame it as a default action ("call canopy_map() first"), not a condition the agent can self-evaluate away. Do not add an empty-state caveat — this guidance is only injected when the map is populated.',
    );
  }

  instructionParts.push(
    '',
    '## Capability summary',
    ...capabilitySummary,
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
    '## Active plans',
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
