import { runAgent } from '@myco/agent/executor.js';
import type { MycoConfig } from '@myco/config/schema.js';
import { DEFAULT_AGENT_ID } from '@myco/constants.js';
import { getCortexInstructions } from '@myco/db/queries/cortex-instructions.js';
import { listReports, type ReportRow } from '@myco/db/queries/reports.js';
import { getLatestRunId, getRun } from '@myco/db/queries/runs.js';
import type { EmbeddingManager } from '@myco/daemon/embedding/manager.js';
import type { TeamSyncClient } from '@myco/daemon/team-sync.js';
import { resolveInstructionDelivery } from '@myco/context/cortex-brief.js';
import { listSymbiontInfos, type SymbiontInfo } from '@myco/daemon/api/symbionts.js';
import { tryParseJson } from '@myco/utils/json.js';

export const CORTEX_PROMPT_BUILDER_TASK = 'cortex-prompt-builder';
const JSON_INDENT = 2;

interface CortexServicesDeps {
  config: MycoConfig;
  embeddingManager?: EmbeddingManager;
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
  reports: Array<{
    id: number;
    action: string;
    summary: string;
    created_at: number;
  }>;
  error?: string | null;
}

export interface CortexPromptBuilderStartResult {
  started: boolean;
  runId: string | null;
  inlineInstructions: boolean;
  targetSymbiont: SymbiontInfo | null;
}

interface CortexPromptBuilderDetails {
  prompt?: string;
}

function getLatestReportForAction(runId: string, action: string): ReportRow | undefined {
  const reports = listReports(runId);
  for (let i = reports.length - 1; i >= 0; i -= 1) {
    if (reports[i]?.action === action) return reports[i];
  }
  return undefined;
}

export function getCortexInstructionsSnapshot(
  config: Pick<MycoConfig, 'context'>,
): CortexInstructionsSnapshot {
  const row = getCortexInstructions(DEFAULT_AGENT_ID);

  return {
    content: row?.content ?? '',
    generatedAt: row?.generated_at ?? null,
    sourceRunId: row?.source_run_id ?? null,
    enabled: config.context.cortex_enabled,
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
): Promise<CortexPromptBuilderStartResult> {
  const targetSymbiont = resolvePromptBuilderSymbiont(vaultDir, requestedSymbiont);
  const delivery = resolveInstructionDelivery(deps.config.context, targetSymbiont);
  const instructions = delivery.inlineInstructions
    ? getCortexInstructions(DEFAULT_AGENT_ID)
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

  const resultPromise = runAgent(vaultDir, {
    task: CORTEX_PROMPT_BUILDER_TASK,
    agentId: DEFAULT_AGENT_ID,
    instruction: builderInstruction,
    embeddingManager: deps.embeddingManager,
  });
  const runId = getLatestRunId(DEFAULT_AGENT_ID, CORTEX_PROMPT_BUILDER_TASK);
  void resultPromise.catch(() => {});

  return {
    started: true,
    runId,
    inlineInstructions: delivery.inlineInstructions,
    targetSymbiont,
  };
}

export function getCortexPromptResult(runId: string): CortexPromptBuilderResult | null {
  const run = getRun(runId);
  if (!run) return null;

  const reports = listReports(runId);
  const promptReport = getLatestReportForAction(runId, 'cortex_prompt_builder');
  const details = tryParseJson<CortexPromptBuilderDetails>(promptReport?.details);

  return {
    runId,
    status: run.status,
    prompt: details?.prompt ?? '',
    reports: reports.map((report) => ({
      id: report.id,
      action: report.action,
      summary: report.summary,
      created_at: report.created_at,
    })),
    error: run.error,
  };
}
