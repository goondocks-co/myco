import type { MycoConfig } from '@myco/config/schema.js';
import type { TeamSyncClient } from '../daemon/team-sync.js';
import {
  TOOL_CONTEXT,
  TOOL_SEARCH,
  TOOL_RECALL,
  TOOL_SESSIONS,
  TOOL_PLANS,
  TOOL_TEAM,
  TOOL_REMEMBER,
  TOOL_SUPERSEDE,
  TOOL_CONSOLIDATE,
  TOOL_COLLECTIVE_SEARCH,
  TOOL_COLLECTIVE_PROJECTS,
  TOOL_COLLECTIVE_PROJECT,
  TOOL_DEFINITIONS,
  COLLECTIVE_TOOL_DEFINITIONS,
} from '../mcp/tool-definitions.js';

export const OPERATING_BRIEF_INJECTION_POINTS = ['session_start'] as const;
export type OperatingBriefInjectionPoint = (typeof OPERATING_BRIEF_INJECTION_POINTS)[number];

const MAX_COLLECTIVE_CAPABILITY_LABELS = 4;

export interface OperatingBriefCapabilities {
  teamEnabled: boolean;
  collectiveConnected: boolean;
  collectiveCapabilities: string[];
  registeredTools: string[];
}

export interface RetrievalGuidance {
  tool: string;
  guidance: string;
  requiresTeam?: boolean;
  requiresCollective?: boolean;
}

export interface DeliveryDecision {
  inlineInstructions: boolean;
  reason: 'missing-symbiont' | 'session-start-supported' | 'session-start-disabled' | 'no-session-start';
}

export const RETRIEVAL_GUIDANCE: RetrievalGuidance[] = [
  {
    tool: TOOL_CONTEXT,
    guidance: 'Use for broad project orientation or when you want the current digest before planning changes.',
  },
  {
    tool: TOOL_SEARCH,
    guidance: 'Use for prior decisions, bugs, and rationale when you know the topic but not the exact note.',
  },
  {
    tool: TOOL_RECALL,
    guidance: 'Use after search finds a promising result and you need the full note.',
  },
  {
    tool: TOOL_SESSIONS,
    guidance: 'Use when continuing related work or recovering recent implementation context.',
  },
  {
    tool: TOOL_PLANS,
    guidance: 'Use before implementation when approved plans or specs may already exist.',
  },
  {
    tool: TOOL_TEAM,
    guidance: 'Use for current team topology and shared project context.',
    requiresTeam: true,
  },
  {
    tool: TOOL_COLLECTIVE_SEARCH,
    guidance: 'Use for cross-project knowledge across the connected collective.',
    requiresCollective: true,
  },
  {
    tool: TOOL_COLLECTIVE_PROJECTS,
    guidance: 'Use to discover relevant collective projects before drilling deeper.',
    requiresCollective: true,
  },
  {
    tool: TOOL_COLLECTIVE_PROJECT,
    guidance: 'Use when you know the collective project and need its focused context.',
    requiresCollective: true,
  },
  {
    tool: TOOL_REMEMBER,
    guidance: 'Use to save durable decisions, gotchas, discoveries, or bug fixes from this work.',
  },
  {
    tool: TOOL_SUPERSEDE,
    guidance: 'Use when existing knowledge is outdated and should stop guiding future runs.',
  },
  {
    tool: TOOL_CONSOLIDATE,
    guidance: 'Use when several related learnings should become one durable wisdom artifact.',
  },
] as const;

export async function resolveOperatingBriefCapabilities(
  config: Pick<MycoConfig, 'team'>,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<OperatingBriefCapabilities> {
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

  const registeredTools = TOOL_DEFINITIONS.map((tool) => tool.name);
  if (collectiveConnected) {
    registeredTools.push(...COLLECTIVE_TOOL_DEFINITIONS.map((tool) => tool.name));
  }

  return {
    teamEnabled,
    collectiveConnected,
    collectiveCapabilities,
    registeredTools,
  };
}

export function shouldInjectOperatingBrief(
  config: MycoConfig['context'],
  injectionPoint: OperatingBriefInjectionPoint,
): boolean {
  return config.operating_brief_enabled && config.operating_brief_inject_on.includes(injectionPoint);
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
  if (!config.operating_brief_enabled) {
    return { inlineInstructions: true, reason: 'session-start-disabled' };
  }
  if (symbiont.supportsSessionStartInjection) {
    return { inlineInstructions: false, reason: 'session-start-supported' };
  }
  return { inlineInstructions: true, reason: 'no-session-start' };
}

export function buildCapabilitySummary(capabilities: OperatingBriefCapabilities): string[] {
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

export function buildRetrievalGuidanceLines(capabilities: OperatingBriefCapabilities): string[] {
  const registeredTools = new Set(capabilities.registeredTools);
  const lines: string[] = [];

  for (const entry of RETRIEVAL_GUIDANCE) {
    if (!registeredTools.has(entry.tool)) continue;
    if (entry.requiresTeam && !capabilities.teamEnabled) continue;
    if (entry.requiresCollective && !capabilities.collectiveConnected) continue;
    lines.push(`- \`${entry.tool}\`: ${entry.guidance}`);
  }

  return lines;
}
