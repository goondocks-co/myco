/**
 * The tool surface a server run holds: materialized per task, each tool a
 * call over the run-control routes, none reading a vault.
 *
 * Every run holds `vault_report`. A `title-summary` run holds two more — the
 * session material it reads and the title it writes — over routes that admit
 * only the credential that dispatched a live run of that task for that
 * session. The tools keep the names and argument shapes the task definition
 * has always used, so one definition serves both the local executor and this
 * runtime.
 */
import { z } from 'zod/v4';
import type { RequestBudget } from '@myco/member/budget.js';
import type { ServerClient } from '@myco/member/transport.js';
import type { MycoToolDefinition } from '../tools/types.js';
import { postRunControl, postRunReport, RunControlError } from './run-store-http.js';

/** The task whose runs read and write one session's title over the run routes. */
export const TITLE_SUMMARY_TASK = 'title-summary';

export interface ServerToolContext {
  client: ServerClient;
  budget: RequestBudget;
  runId: string;
  agentId: string;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });

/** Reports over the run-control surface; the one tool every server run holds. */
export function materializedReportTool(ctx: ServerToolContext, counter: { reports: number }): MycoToolDefinition {
  return {
    name: 'vault_report',
    description: 'Record an observability report for the current run. Use action "skip" when skipping expected operations, with reasoning in the summary field.',
    inputSchema: {
      action: z.string().describe('Action name (e.g., extract, digest, container-smoke, skip)'),
      summary: z.string().describe('Human-readable summary of what was done'),
      details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { action: string; summary: string; details?: Record<string, unknown> }) => {
      await postRunReport(ctx.client, ctx.budget, {
        runId: ctx.runId,
        agentId: ctx.agentId,
        action: args.action,
        summary: args.summary,
        details: args.details === undefined ? null : JSON.stringify(args.details),
      });
      counter.reports += 1;
      return text(`report recorded: ${args.action}`);
    },
  };
}

/** The session material a titling run reads, in the shape the task has always read it. */
export function materializedSessionMaterialTool(ctx: ServerToolContext): MycoToolDefinition {
  return {
    name: 'vault_session_summary_material',
    description: 'Get compact title-and-summary material for one session in a single read: current title/summary plus an ordered prompt-batch arc with only user prompts and assistant summaries.',
    inputSchema: {
      session_id: z.string().describe('Session ID whose summary material should be returned'),
      include_active: z.boolean().optional().describe('Allow active sessions (default: true for exact session reads)'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { session_id: string }) => {
      const answered = await postRunControl(ctx.client, ctx.budget, '/runs/session-material', { runId: ctx.runId, sessionId: args.session_id });
      return text(answered.material ?? { session_id: args.session_id, found: false, batches: [] });
    },
  };
}

/** The title and summary a titling run writes. Both are required: the server refuses a half. */
export function materializedUpdateSessionTool(ctx: ServerToolContext, counter: { writes: number }): MycoToolDefinition {
  return {
    name: 'vault_update_session',
    description: 'Update a session title and summary. Provide BOTH title and summary. Title should be under 80 characters and reflect the full session scope.',
    inputSchema: {
      session_id: z.string().describe('Session ID to update'),
      title: z.string().optional().describe('New session title'),
      summary: z.string().optional().describe('New session summary'),
    },
    annotations: { idempotentHint: true },
    handler: async (args: { session_id: string; title?: string; summary?: string }) => {
      if (args.title === undefined || args.summary === undefined) {
        return text({ error: 'both title and summary are required; call again with both' });
      }
      let answered: Record<string, unknown>;
      try {
        answered = await postRunControl(ctx.client, ctx.budget, '/runs/session-title', {
          runId: ctx.runId, sessionId: args.session_id, title: args.title, summary: args.summary,
        });
      } catch (error) {
        // A title outside its bound is the model's to fix: answered as a tool result on every harness, never a failed run.
        if (error instanceof RunControlError) return text({ error: error.message });
        throw error;
      }
      if (answered.held !== true) return text({ error: `Session not found: ${args.session_id}` });
      if (answered.written !== true) return text({ error: 'the session already carries a title written by another hand; nothing changed' });
      counter.writes += 1;
      return text({ session_id: args.session_id, title: args.title, summary: args.summary });
    },
  };
}

/** The tools a run of `taskName` holds. */
export function materializedToolsForTask(taskName: string, ctx: ServerToolContext, counter: { reports: number; writes: number }): MycoToolDefinition[] {
  const tools = [materializedReportTool(ctx, counter)];
  if (taskName === TITLE_SUMMARY_TASK) {
    tools.push(materializedSessionMaterialTool(ctx), materializedUpdateSessionTool(ctx, counter));
  }
  return tools;
}
