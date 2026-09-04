/**
 * The tool surface a server run holds: materialized per task, each tool a
 * call over the run-control routes, none reading a vault.
 *
 * Every run holds `vault_report`. A `title-summary` run holds two more — the
 * session material it reads and the title it writes. A `supersession-sweep` run
 * holds four — an inventory of previews, one spore in full, and the two writes —
 * so a sweep surveys a whole vault by its previews and pulls bodies only for the
 * clusters it means to resolve. A `cortex-instructions` run holds four reads —
 * spore previews, one spore in full, the settled sessions, and the digest — and
 * files its artifact through its report. A `digest-only` run holds those same
 * four reads and the tier write. Every route admits only the credential that
 * dispatched a live run of that task. The tools keep the names and argument
 * shapes the task definition has always used, so one definition serves both the
 * local executor and this runtime.
 */
import { z } from 'zod/v4';
import type { RequestBudget } from '@myco/member/budget.js';
import type { ServerClient } from '@myco/member/transport.js';
import { RESOLUTION_ACTIONS, SPORE_STATUSES } from '@myco/constants/spore-status.js';
import { OBSERVATION_TYPES } from '../../vault/types.js';
import type { MycoToolDefinition } from '../tools/types.js';
import { postRunControl, postRunReport, RunControlError } from './run-store-http.js';

/** The task whose runs read and write one session's title over the run routes. */
export const TITLE_SUMMARY_TASK = 'title-summary';
/** The task whose runs read and resolve this Project's spores over the run routes. */
export const SUPERSESSION_SWEEP_TASK = 'supersession-sweep';
/** The task whose runs author this Project's session-start instructions. */
export const CORTEX_INSTRUCTIONS_TASK = 'cortex-instructions';
/** The task whose runs regenerate this Project's digest extracts. */
export const DIGEST_TASK = 'digest-only';
/** Every task this runtime materializes a tool surface for. */
export const SERVED_TASKS: readonly string[] = [TITLE_SUMMARY_TASK, SUPERSESSION_SWEEP_TASK, CORTEX_INSTRUCTIONS_TASK, DIGEST_TASK];
/** The tasks whose prompt the server builds; a run of one reads it back over `/runs/instruction` rather than from its environment. */
export const INSTRUCTED_TASKS: readonly string[] = [CORTEX_INSTRUCTIONS_TASK, DIGEST_TASK];
/** The report action a `cortex-instructions` run records its artifact under; the same call files the artifact itself. */
export const CORTEX_INSTRUCTIONS_ACTION = 'cortex_instructions';

export interface ServerToolContext {
  client: ServerClient;
  budget: RequestBudget;
  runId: string;
  agentId: string;
}

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }] });

/** The instructions body a report carries, or null when the report is not the one that files an artifact. */
function instructionsContentOf(args: { action: string; details?: Record<string, unknown> }): string | null {
  if (args.action !== CORTEX_INSTRUCTIONS_ACTION) return null;
  const content = args.details?.content;
  return typeof content === 'string' && content.trim() !== '' ? content : null;
}

/**
 * Reports over the run-control surface; the one tool every server run holds.
 *
 * A `cortex_instructions` report carrying a body files the artifact through the
 * route admitted to this run BEFORE the report lands, and the report lands
 * either way: the close gate reads the report as the run's evidence, and a
 * report that vanished on a refused write would leave a run that did its work
 * indistinguishable from one that did not.
 */
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
      const content = instructionsContentOf(args);
      let failure: string | null = null;
      if (content !== null) {
        try {
          const answered = await postRunControl(ctx.client, ctx.budget, '/runs/instructions-write', { runId: ctx.runId, content });
          if (answered.held !== true) failure = 'this run holds no instructions surface; the artifact was not stored';
          else if (answered.written !== true) failure = 'the artifact was not stored for this run';
        } catch (error) {
          if (!(error instanceof RunControlError)) throw error;
          failure = error.message;
        }
      }
      await postRunReport(ctx.client, ctx.budget, {
        runId: ctx.runId,
        agentId: ctx.agentId,
        action: args.action,
        summary: args.summary,
        details: args.details === undefined ? null : JSON.stringify(args.details),
      });
      counter.reports += 1;
      return failure === null ? text(`report recorded: ${args.action}`) : text({ error: failure });
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

/** A tool answer a run may act on: the route served no run for this caller. */
const NO_RUN = { error: 'this run holds no such surface' };

/**
 * One call over a run route, answered as a tool result whatever happens: a
 * refusal and a lost connection are the model's to act on, never a failed run.
 */
async function askRunControl(ctx: ServerToolContext, path: string, payload: Record<string, unknown>): Promise<Record<string, unknown> | { error: string }> {
  try {
    const answered = await postRunControl(ctx.client, ctx.budget, path, payload);
    return answered.held === true ? answered : NO_RUN;
  } catch (error) {
    if (error instanceof RunControlError) return { error: error.message };
    throw error;
  }
}

const errored = (answered: Record<string, unknown> | { error: string }): answered is { error: string } => typeof (answered as { error?: unknown }).error === 'string';

/** The Project's spores as one bounded line each, with the total behind the page. */
export function materializedSporesTool(ctx: ServerToolContext): MycoToolDefinition {
  return {
    name: 'vault_spores',
    description: 'List spores as previews — id, observation type, importance, created time, and the first 200 characters of the body — with the total behind the page. Read a body in full with vault_spore.',
    inputSchema: {
      status: z.enum(SPORE_STATUSES).optional().describe('Filter by status (default: active)'),
      observation_type: z.string().optional().describe('Filter by observation type (e.g., gotcha, decision)'),
      search: z.string().optional().describe('Keep only spores whose content or type contains this text'),
      limit: z.number().optional().describe('Maximum number of spores to return (max 200)'),
      offset: z.number().optional().describe('How many spores to skip, for paging through the total'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { status?: string; observation_type?: string; search?: string; limit?: number; offset?: number }) => {
      const answered = await askRunControl(ctx, '/runs/spores', { runId: ctx.runId, ...args });
      if (errored(answered)) return text(answered);
      return text({ spores: answered.spores, total: answered.total });
    },
  };
}

/** One spore in full, with what supersedes it and what it grew out of. */
export function materializedSporeTool(ctx: ServerToolContext): MycoToolDefinition {
  return {
    name: 'vault_spore',
    description: 'Read one spore in full — its whole body, context, tags and properties — with the ids that supersede it and the ids it replaced.',
    inputSchema: {
      id: z.string().max(192).describe('ID of the spore to read'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { id: string }) => {
      const answered = await askRunControl(ctx, '/runs/spore', { runId: ctx.runId, id: args.id });
      if (errored(answered)) return text(answered);
      if (answered.budget === 'spent') return text({ error: 'the full-read budget for this run is spent; judge the rest by their previews from vault_spores' });
      if (answered.spore === null) return text({ error: `Spore not found: ${args.id}` });
      return text({ spore: answered.spore, truncated: answered.truncated, superseded_by: answered.supersededBy, supersedes: answered.supersedes });
    },
  };
}

/** The spore a run records; its agent and session come from the run, never from the caller. */
export function materializedCreateSporeTool(ctx: ServerToolContext, counter: { writes: number }): MycoToolDefinition {
  return {
    name: 'vault_create_spore',
    description: 'Create a new spore (observation) in the vault. The agent_id is set automatically.',
    inputSchema: {
      observation_type: z.enum(OBSERVATION_TYPES).describe('Spore kind. Direct extraction: gotcha, bug_fix, decision, discovery, trade_off, cross-cutting. Synthesized (consolidation / seed): wisdom, pattern, architecture.'),
      content: z.string().describe('The observation content in markdown'),
      importance: z.number().optional().describe('Importance score 1-10 (default 5)'),
      tags: z.array(z.string()).optional().describe('Tags for categorization'),
      context: z.string().optional().describe('Additional context about the observation'),
      properties: z.string().optional().describe('JSON metadata (e.g., {"consolidated_from": [...]} for wisdom spores)'),
    },
    annotations: { openWorldHint: true },
    handler: async (args: { observation_type: string; content: string; importance?: number; tags?: string[]; context?: string; properties?: string }) => {
      const answered = await askRunControl(ctx, '/runs/spore-create', { runId: ctx.runId, ...args });
      if (errored(answered)) return text(answered);
      counter.writes += 1;
      return text({ spore: answered.spore });
    },
  };
}

/** The resolutions a run makes: one superseded, one obsolete, or a set consolidated into a wisdom spore this call records. */
export function materializedResolveSporeTool(ctx: ServerToolContext, counter: { writes: number }): MycoToolDefinition {
  return {
    name: 'vault_resolve_spore',
    description: 'Resolve a spore by updating its status and recording a resolution event.',
    inputSchema: {
      spore_id: z.string().max(192).describe('ID of the spore to resolve'),
      action: z.enum(RESOLUTION_ACTIONS).describe('Resolution action: supersede (replaced by a newer spore), consolidate (merged into a wisdom note), or obsolete (no longer relevant, no replacement)'),
      new_spore_id: z.string().max(192).optional().describe('ID of the replacement spore (required for supersede and consolidate)'),
      reason: z.string().optional().describe('Explanation for the resolution'),
    },
    annotations: { destructiveHint: true },
    handler: async (args: { spore_id: string; action: string; new_spore_id?: string; reason?: string }) => {
      const answered = await askRunControl(ctx, '/runs/spore-resolve', { runId: ctx.runId, ...args });
      if (errored(answered)) return text(answered);
      if (answered.resolved !== true) return text({ error: `Spore not found: ${args.spore_id}` });
      counter.writes += 1;
      return text({ action: answered.action, spore: answered.spore });
    },
  };
}

/** The Project's settled sessions, newest first, each one line with the opening of its summary. */
export function materializedSessionsTool(ctx: ServerToolContext): MycoToolDefinition {
  return {
    name: 'vault_sessions',
    description: 'List this project\'s settled sessions, newest first — id, label, start and end, title, and the opening of the summary. Sessions still in flight are never listed.',
    inputSchema: {
      limit: z.number().optional().describe('Maximum number of sessions to return; a larger ask is answered with this run\'s own page ceiling'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { limit?: number }) => {
      const answered = await askRunControl(ctx, '/runs/sessions', { runId: ctx.runId, ...args });
      if (errored(answered)) return text(answered);
      return text({ sessions: answered.sessions });
    },
  };
}

/** The Project's digest: one tier in full, or what each tier holds when no tier is named. */
export function materializedReadDigestTool(ctx: ServerToolContext): MycoToolDefinition {
  return {
    name: 'vault_read_digest',
    description: 'Read the current digest. With no arguments it returns what each tier holds; with a tier it returns that tier\'s content in full. A run that only reads may be served the nearest tier the project has instead, and the answer says so with "fallback": true; a run that writes the digest is served the tier it asked for or nothing.',
    inputSchema: {
      tier: z.number().optional().describe('Tier to read in full (1500, 5000, or 10000). Omit for a summary of all tiers.'),
    },
    annotations: { readOnlyHint: true },
    handler: async (args: { tier?: number }) => {
      const answered = await askRunControl(ctx, '/runs/digest', { runId: ctx.runId, ...args });
      if (errored(answered)) return text(answered);
      return text(args.tier === undefined ? { tiers: answered.tiers } : { digest: answered.digest });
    },
  };
}

/**
 * One tier of the digest the run writes. The tier and the body are the model's;
 * everything filed beside them — the agent, the substrate hash, and what the
 * material counted — comes off the run row.
 */
export function materializedWriteDigestTool(ctx: ServerToolContext, counter: { writes: number }): MycoToolDefinition {
  return {
    name: 'vault_write_digest',
    description: 'Write or update a digest extract at a specific token tier. Uses UPSERT on (agent_id, tier).',
    inputSchema: {
      tier: z.number().describe('Token budget tier (e.g., 1500, 5000, 10000)'),
      content: z.string().describe('The digest extract content in markdown'),
    },
    annotations: { idempotentHint: true },
    handler: async (args: { tier: number; content: string }) => {
      const answered = await askRunControl(ctx, '/runs/digest-write', { runId: ctx.runId, tier: args.tier, content: args.content });
      if (errored(answered)) return text(answered);
      if (answered.written !== true) return text({ error: 'the digest was not stored for this run' });
      counter.writes += 1;
      return text({ tier: answered.tier, revision_of: answered.revisionOf });
    },
  };
}

/** The tools a run of `taskName` holds. */
export function materializedToolsForTask(taskName: string, ctx: ServerToolContext, counter: { reports: number; writes: number }): MycoToolDefinition[] {
  const tools = [materializedReportTool(ctx, counter)];
  if (taskName === TITLE_SUMMARY_TASK) {
    tools.push(materializedSessionMaterialTool(ctx), materializedUpdateSessionTool(ctx, counter));
  }
  if (taskName === SUPERSESSION_SWEEP_TASK) {
    tools.push(materializedSporesTool(ctx), materializedSporeTool(ctx), materializedCreateSporeTool(ctx, counter), materializedResolveSporeTool(ctx, counter));
  }
  if (taskName === CORTEX_INSTRUCTIONS_TASK) {
    tools.push(materializedSporesTool(ctx), materializedSporeTool(ctx), materializedSessionsTool(ctx), materializedReadDigestTool(ctx));
  }
  if (taskName === DIGEST_TASK) {
    tools.push(
      materializedSporesTool(ctx), materializedSporeTool(ctx), materializedSessionsTool(ctx),
      materializedReadDigestTool(ctx), materializedWriteDigestTool(ctx, counter),
    );
  }
  return tools;
}
