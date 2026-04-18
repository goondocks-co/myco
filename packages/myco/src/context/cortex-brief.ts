import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '../daemon/team-sync.js';
import {
  TOOL_DEFINITIONS,
  COLLECTIVE_TOOL_DEFINITIONS,
  getToolCortexPriority,
  type ToolDefinition,
} from '../mcp/tool-definitions.js';

const MAX_COLLECTIVE_CAPABILITY_LABELS = 4;
const ALL_CORTEX_TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ...COLLECTIVE_TOOL_DEFINITIONS];

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
