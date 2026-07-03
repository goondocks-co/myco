/**
 * Observability vault tools.
 *
 * 1 tool: vault_report
 */

import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { textResult, stampRunIdInPayload, type VaultToolDeps } from './types.js';
import { rowProjectIdFromRequestContext } from '@myco/grove/request-context.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createObservabilityTools(deps: VaultToolDeps) {
  const { runId, agentId } = deps;
  const projectId = rowProjectIdFromRequestContext(deps.requestContext);

  const vaultReport = {
    ...tool(
      'vault_report',
      'Record an observability report for the current run. Use action "skip" when skipping expected operations (e.g., the digest is already current and needs no update) with reasoning in the summary field. When details contains a run_id field, the daemon stamps it to the current run\'s id server-side — you do not need to reproduce the run id exactly.',
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
      { annotations: { readOnlyHint: true } },
    ),
    // Same fabricated-run_id class as vault_set_state: skill-evolve's
    // assess report details carry a run_id the postconditions validate.
    // `details` is already an object on the wire — stamp in place.
    normalizeArgs: (args: Record<string, unknown>, ctx: { runId: string }) => {
      const stamped = stampRunIdInPayload(args.details, ctx.runId);
      if (stamped === args.details) return args;
      return { ...args, details: stamped };
    },
  };

  return [vaultReport];
}
