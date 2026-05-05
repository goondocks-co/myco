/**
 * Observability vault tools.
 *
 * 1 tool: vault_report
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { textResult, type VaultToolDeps } from './types.js';
import { rowProjectIdFromRequestContext } from '@myco/tools/request-context.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObservabilityTools(deps: VaultToolDeps) {
  const { runId, agentId } = deps;
  const projectId = rowProjectIdFromRequestContext(deps.requestContext);

  const vaultReport = tool(
    'vault_report',
    'Record an observability report for the current run. Use action "skip" when skipping expected operations (e.g., not updating a session summary) with reasoning in the summary field.',
    {
      action: z.string().describe('Action name (e.g., extract, consolidate, digest, skip)'),
      summary: z.string().describe('Human-readable summary of what was done'),
      details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs'),
    },
    async (args) => {
      const now = epochSeconds();

      const report = insertReport({
        run_id: runId,
        project_id: projectId,
        agent_id: agentId,
        action: args.action,
        summary: args.summary,
        details: args.details ? JSON.stringify(args.details) : null,
        created_at: now,
      });

      return textResult(report);
    },
    { annotations: {} },
  );

  return [vaultReport];
}
