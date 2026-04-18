import { createHash } from 'node:crypto';
import type { MycoConfig } from '@myco/config/schema.js';
import { CONTENT_HASH_ALGORITHM, DEFAULT_AGENT_ID, DIGEST_FALLBACK_TIER } from '@myco/constants.js';
import { getDigestExtract } from '@myco/db/queries/digest-extracts.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { listPlans } from '@myco/db/queries/plans.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import { listSpores } from '@myco/db/queries/spores.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';
import {
  buildCapabilitySummary,
  buildRetrievalGuidanceLines,
  resolveCortexCapabilities,
} from '@myco/context/cortex-brief.js';

const RECENT_SESSION_LIMIT = 3;
const RECENT_SPORE_LIMIT = 4;
const RECENT_PLAN_LIMIT = 3;
const CONTENT_PREVIEW_MAX_CHARS = 240;
const DIGEST_EXCERPT_MAX_CHARS = 900;
const JSON_INDENT = 2;

export const CORTEX_SKILLS_NOTE = 'Project and Myco skills are already registered with the agent separately. Tell the agent to use those skills directly when relevant, and do not instruct it to call `myco_skills`.';

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
    includeActive: true,
    limit: RECENT_SESSION_LIMIT,
  });
  if (sessions.length === 0) return 'No recent sessions are available.';

  return sessions.map((session) => {
    const parts = [
      `- ${session.title ?? session.id}`,
      session.branch ? `branch=${session.branch}` : null,
      truncatePreview(session.summary),
    ].filter(Boolean);
    return parts.join(' — ');
  }).join('\n');
}

function formatRecentSpores(): string {
  const spores = listSpores({
    includeActive: true,
    status: 'active',
    limit: RECENT_SPORE_LIMIT,
  });
  if (spores.length === 0) return 'No recent spores are available.';

  return spores.map((spore) => {
    const parts = [
      `- [${spore.observation_type}] ${truncatePreview(spore.content)}`,
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
  getTeamClient?: () => TeamSyncClient | null,
): Promise<CortexInstructionPayload> {
  const capabilities = await resolveCortexCapabilities(config, getTeamClient);
  const capabilitySummary = buildCapabilitySummary(capabilities);
  const retrievalGuidance = buildRetrievalGuidanceLines(capabilities);
  const recentSessions = formatRecentSessions();
  const recentSpores = formatRecentSpores();
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
    recentSpores,
    recentPlans,
    skillsNote: CORTEX_SKILLS_NOTE,
  };

  return {
    inputHash: hashInput(input),
    instruction: [
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
      '## Recent spores',
      recentSpores,
      '',
      '## Active plans',
      recentPlans,
    ].join('\n'),
  };
}

export async function buildScheduledCortexInstruction(
  config: MycoConfig,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<CortexInstructionPayload | undefined> {
  const built = await buildCortexInstructionsInput(config, getTeamClient);
  const existing = getCortexInstructions(DEFAULT_AGENT_ID);
  if (existing?.input_hash === built.inputHash) {
    return undefined;
  }
  return built;
}
