/**
 * `myco_cortex` over the Deployment's project intelligence: the standing
 * instructions a session starts from, and the activity of every Project.
 *
 * The instructions are the `instructions.template` Settings leaf, which any
 * member edits — static text the Deployment stores and serves, not an artifact
 * a run generates. The answer carries the Project id beside it: an agent that
 * reads its instructions over MCP learns, in the same call, the value it must
 * pass as `project` on a write.
 *
 * The notification and maintenance ops are named in the registry as not yet
 * served; nothing here answers them.
 */
import { listProjects } from '../../read/sessions.js';
import { instructionsTemplate } from '../../core/settings.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The answer when a Deployment holds no template; an empty answer would read as a failure to retrieve one. */
export const NO_INSTRUCTIONS_MESSAGE = 'This Deployment has no session-start instructions. An owner writes them under Settings.';

export interface InstructionsResult {
  content: string;
  project_id: string;
  configured: boolean;
}

export async function handleCortexInstructions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const template = (await instructionsTemplate(ctx.env.db)).trim();
  return {
    content: template.length === 0 ? NO_INSTRUCTIONS_MESSAGE : template,
    project_id: scope.projectId,
    configured: template.length > 0,
  } satisfies InstructionsResult;
}

/** Every Project of the Deployment with its last activity; `active` when something arrived in the last seven days. */
export async function handleCortexProjectsActivity(_input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const projects = await listProjects(ctx.env.db);
  return {
    projects: projects.map((p) => ({
      id: p.projectId,
      name: p.name,
      session_count: p.sessionCount,
      last_activity_at: p.lastActivityAt,
      active: p.lastActivityAt !== null && ctx.now - p.lastActivityAt <= ACTIVE_WINDOW_MS,
    })),
  };
}
