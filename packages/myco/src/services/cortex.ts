import { createHash } from 'node:crypto';
import { hasConfiguredProvider } from '@myco/agent/config-resolver.js';
import { runAgent } from '@myco/agent/executor.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID, epochSeconds, CONTENT_HASH_ALGORITHM } from '@myco/constants.js';
import { getCortexInstructions, upsertCortexInstructions, type CortexInstructionsRow } from '@myco/db/queries/cortex-instructions.js';
import { listReports, type ReportRow } from '@myco/db/queries/reports.js';
import { listSessions } from '@myco/db/queries/sessions.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';
import {
  buildCapabilitySummary,
  buildRetrievalGuidanceLines,
  resolveInstructionDelivery,
  resolveOperatingBriefCapabilities,
  resolveOperatingBriefTokenBudget,
  trimOperatingBriefText,
} from '@myco/context/operating-brief.js';
import { listSymbiontInfos, type SymbiontInfo } from '@myco/daemon/api/symbionts.js';

export const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';
export const CORTEX_PROMPT_BUILDER_TASK = 'cortex-prompt-builder';

const RECENT_ACTIVITY_LIMIT = 3;
const RECENT_ACTIVITY_SUMMARY_MAX_CHARS = 240;
const JSON_INDENT = 2;

interface CortexServicesDeps {
  config: MycoConfig;
  getTeamClient?: () => TeamSyncClient | null;
}

export interface CortexInstructionsSnapshot {
  content: string;
  generatedAt: number | null;
  sourceRunId: string | null;
  enabled: boolean;
  stored: boolean;
}

export interface CortexPromptBuilderResult {
  runId: string;
  status: string;
  prompt: string;
  inlineInstructions: boolean;
  targetSymbiont: SymbiontInfo | null;
  reports: Array<{
    id: number;
    action: string;
    summary: string;
    created_at: number;
  }>;
}

interface CortexInstructionsDetails {
  content?: string;
}

interface CortexPromptBuilderDetails {
  prompt?: string;
}

function hashInput(value: unknown): string {
  return createHash(CONTENT_HASH_ALGORITHM)
    .update(JSON.stringify(value))
    .digest('hex');
}

function truncateRecentActivity(text: string | null): string | null {
  if (!text) return null;
  return text.length > RECENT_ACTIVITY_SUMMARY_MAX_CHARS
    ? `${text.slice(0, RECENT_ACTIVITY_SUMMARY_MAX_CHARS)}...`
    : text;
}

function formatRecentActivity(): string {
  const sessions = listSessions({
    includeActive: true,
    limit: RECENT_ACTIVITY_LIMIT,
  });
  if (sessions.length === 0) return 'No recent session activity is available.';

  return sessions.map((session) => {
    const parts = [
      `- ${session.title ?? session.id}`,
      session.branch ? `branch=${session.branch}` : null,
      truncateRecentActivity(session.summary),
    ].filter(Boolean);
    return parts.join(' — ');
  }).join('\n');
}

function parseReportDetails<T>(report: ReportRow | undefined): T | null {
  if (!report?.details) return null;
  try {
    return JSON.parse(report.details) as T;
  } catch {
    return null;
  }
}

function getLatestReportForAction(runId: string, action: string): ReportRow | undefined {
  const reports = listReports(runId);
  for (let index = reports.length - 1; index >= 0; index -= 1) {
    if (reports[index]?.action === action) {
      return reports[index];
    }
  }
  return undefined;
}

async function buildInstructionsInput(
  config: MycoConfig,
  getTeamClient?: () => TeamSyncClient | null,
): Promise<{
  inputHash: string;
  instruction: string;
}> {
  const capabilities = await resolveOperatingBriefCapabilities(config, getTeamClient);
  const capabilitySummary = buildCapabilitySummary(capabilities);
  const retrievalGuidance = buildRetrievalGuidanceLines(capabilities);
  const recentActivity = formatRecentActivity();
  const input = {
    context: {
      digest_tier: config.context.digest_tier,
      operating_brief_enabled: config.context.operating_brief_enabled,
      operating_brief_max_tokens: resolveOperatingBriefTokenBudget(config.context),
      prompt_search: config.context.prompt_search,
      prompt_max_spores: config.context.prompt_max_spores,
    },
    capabilities,
    recentActivity,
  };

  return {
    inputHash: hashInput(input),
    instruction: [
      'Author compact session-start instructions for another coding agent.',
      'Focus on teaching how to use Myco retrieval correctly. Do not restate AGENTS.md.',
      '',
      '## Runtime config',
      JSON.stringify(input.context, null, JSON_INDENT),
      '',
      '## Capability summary',
      ...capabilitySummary,
      '',
      '## Retrieval guidance to encode',
      ...retrievalGuidance,
      '',
      '## Recent project activity',
      recentActivity,
    ].join('\n'),
  };
}

async function ensureCortexInstructions(
  vaultDir: string,
  deps: CortexServicesDeps,
  options: { force?: boolean } = {},
): Promise<CortexInstructionsRow | null> {
  const existing = getCortexInstructions(DEFAULT_AGENT_ID);
  const { inputHash, instruction } = await buildInstructionsInput(deps.config, deps.getTeamClient);

  if (!options.force && existing?.input_hash === inputHash) {
    return existing;
  }

  if (!hasConfiguredProvider(deps.config, CORTEX_INSTRUCTIONS_TASK)) {
    return existing;
  }

  const result = await runAgent(vaultDir, {
    task: CORTEX_INSTRUCTIONS_TASK,
    agentId: DEFAULT_AGENT_ID,
    instruction,
  });
  if (result.status !== 'completed') {
    return existing;
  }

  const report = getLatestReportForAction(result.runId, 'cortex_instructions');
  const details = parseReportDetails<CortexInstructionsDetails>(report);
  const content = trimOperatingBriefText(
    details?.content ?? '',
    resolveOperatingBriefTokenBudget(deps.config.context),
  );
  if (!content) {
    return existing;
  }

  return upsertCortexInstructions({
    agent_id: DEFAULT_AGENT_ID,
    content,
    input_hash: inputHash,
    generated_at: epochSeconds(),
    source_run_id: result.runId,
  });
}

export async function getCortexInstructionsSnapshot(
  vaultDir: string,
  deps: CortexServicesDeps,
): Promise<CortexInstructionsSnapshot> {
  const row = deps.config.context.operating_brief_enabled
    ? await ensureCortexInstructions(vaultDir, deps)
    : getCortexInstructions(DEFAULT_AGENT_ID);

  return {
    content: row?.content ?? '',
    generatedAt: row?.generated_at ?? null,
    sourceRunId: row?.source_run_id ?? null,
    enabled: deps.config.context.operating_brief_enabled,
    stored: Boolean(row),
  };
}

export async function refreshCortexInstructions(
  vaultDir: string,
  deps: CortexServicesDeps,
): Promise<CortexInstructionsSnapshot> {
  const row = await ensureCortexInstructions(vaultDir, deps, { force: true });
  return {
    content: row?.content ?? '',
    generatedAt: row?.generated_at ?? null,
    sourceRunId: row?.source_run_id ?? null,
    enabled: deps.config.context.operating_brief_enabled,
    stored: Boolean(row),
  };
}

function resolvePromptBuilderSymbiont(vaultDir: string, requestedName?: string): SymbiontInfo | null {
  const enabledSymbionts = listSymbiontInfos(vaultDir).filter((symbiont) => symbiont.enabled);
  if (enabledSymbionts.length === 0) return null;
  if (!requestedName) return enabledSymbionts[0] ?? null;
  return enabledSymbionts.find((symbiont) => symbiont.name === requestedName) ?? null;
}

export async function buildCortexPrompt(
  vaultDir: string,
  deps: CortexServicesDeps,
  goal: string,
  requestedSymbiont?: string,
): Promise<CortexPromptBuilderResult> {
  const targetSymbiont = resolvePromptBuilderSymbiont(vaultDir, requestedSymbiont);
  const delivery = resolveInstructionDelivery(deps.config.context, targetSymbiont);
  const instructions = delivery.inlineInstructions
    ? await ensureCortexInstructions(vaultDir, deps)
    : null;

  const builderInstruction = [
    `Goal:\n${goal.trim()}`,
    '',
    '## Target symbiont',
    JSON.stringify(
      targetSymbiont
        ? {
            name: targetSymbiont.name,
            displayName: targetSymbiont.displayName,
            supportsSessionStartInjection: targetSymbiont.supportsSessionStartInjection,
            supportsPromptSubmitInjection: targetSymbiont.supportsPromptSubmitInjection,
          }
        : null,
      null,
      JSON_INDENT,
    ),
    '',
    '## Delivery contract',
    JSON.stringify(
      {
        inline_instructions: delivery.inlineInstructions,
        reason: delivery.reason,
      },
      null,
      JSON_INDENT,
    ),
    '',
    delivery.inlineInstructions
      ? [
          '## Current Cortex session-start instructions',
          instructions?.content || 'No current Cortex instructions are available.',
          '',
        ].join('\n')
      : '## Current Cortex session-start instructions\nOmit them from the prompt because this symbiont receives session-start injection.\n',
  ].join('\n');

  const result = await runAgent(vaultDir, {
    task: CORTEX_PROMPT_BUILDER_TASK,
    agentId: DEFAULT_AGENT_ID,
    instruction: builderInstruction,
  });

  const reports = listReports(result.runId);
  const promptReport = getLatestReportForAction(result.runId, 'cortex_prompt_builder');
  const details = parseReportDetails<CortexPromptBuilderDetails>(promptReport);

  return {
    runId: result.runId,
    status: result.status,
    prompt: details?.prompt ?? '',
    inlineInstructions: delivery.inlineInstructions,
    targetSymbiont,
    reports: reports.map((report) => ({
      id: report.id,
      action: report.action,
      summary: report.summary,
      created_at: report.created_at,
    })),
  };
}
