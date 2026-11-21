/**
 * `myco_cortex` over the Deployment's project intelligence: the standing
 * instructions a session starts from, the Project's repository map, and the
 * activity of every Project.
 *
 * The instructions are the `instructions.template` Settings leaf, which any
 * member edits — static text the Deployment stores and serves, not an artifact
 * a run generates. The answer carries the Project id beside it: an agent that
 * reads its instructions over MCP learns, in the same call, the value it must
 * pass as `project` on a write.
 *
 * A prompt preview answers what the prompt hook would attach for one prompt's
 * text, by the same selection, without a session and without recording
 * anything.
 *
 * The notification and maintenance ops are named in the registry as not yet
 * served; nothing here answers them.
 */
import { renderMap } from '@goondocks/myco-shared/canopy';
import { readCanopyMap } from '../../read/canopy.js';
import { sessions_listProjects as listProjects } from '../../read/catalog/sessions.js';
import { instructionsTemplate } from '../../core/settings.js';
import { failure, scopeOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';
import { PROMPT_PREVIEW_MAX_CHARS, previewPromptItems } from '../../core/injection.js';
import { readRecallLeaves } from '../../core/recall.js';
import { resolveSemanticSearch } from '../../core/search.js';
import { settingsWriter } from '../../core/settings.js';
import { ContextTimings } from '../../core/context-timing.js';
import { snake } from '../shape.js';

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** The answer when a Deployment holds no template; an empty answer would read as a failure to retrieve one. */
export const NO_INSTRUCTIONS_MESSAGE = 'This Deployment has no session-start instructions. An owner writes them under Settings.';

interface InstructionsResult {
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

/** The answer when the Project holds no map yet. */
export const NO_MAP_MESSAGE = 'No repository map yet. A map run writes one once the Project connects its repository.';

interface CanopyMapResult {
  content: string;
  project_id: string;
  generated_at?: number;
  revision?: string;
  repository?: { url: string; branch: string; commit: string };
  is_empty?: true;
  message?: string;
}

/** The Project's repository map, rendered as markdown, with the commit it reflects. */
export async function handleCortexCanopyMap(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const map = await readCanopyMap(ctx.env.db, scope);
  if (map === null) return { content: '', project_id: scope.projectId, is_empty: true, message: NO_MAP_MESSAGE } satisfies CanopyMapResult;
  return {
    content: renderMap(map.artifact, map.repository, { includeProvenance: false }),
    project_id: scope.projectId,
    generated_at: map.generatedAt,
    revision: map.revision,
    repository: map.repository,
  } satisfies CanopyMapResult;
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

/** A valid preview call, named by every preview refusal. */
export const PROMPT_PREVIEW_EXAMPLE = { op: 'prompt_preview', prompt: 'How do we retry a stalled delivery?' };

const round = (n: number): number => Math.round(n * 1000) / 1000;

/**
 * What the prompt hook would attach in this Project for `prompt`: the items in order with the score each was chosen by,
 * the scored spores left out nearest the cut and why, the block's text and how long the selection took. Nothing is
 * reserved or recorded as delivered.
 */
export async function handleCortexPromptPreview(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const prompt = input.prompt;
  if (typeof prompt !== 'string' || prompt.length === 0)
    return failure(`Not previewed: op "prompt_preview" needs prompt, the text of one prompt of at most ${PROMPT_PREVIEW_MAX_CHARS} characters. Next call: myco_cortex ${JSON.stringify(PROMPT_PREVIEW_EXAMPLE)}`);
  if (prompt.length > PROMPT_PREVIEW_MAX_CHARS)
    return failure(`Not previewed: prompt is ${prompt.length} characters; the limit is ${PROMPT_PREVIEW_MAX_CHARS}. Next call: myco_cortex ${JSON.stringify({ op: 'prompt_preview', prompt: `<its first ${PROMPT_PREVIEW_MAX_CHARS} characters>` })}`);
  const [leaves, capabilityOn] = await Promise.all([readRecallLeaves(ctx.env.db), settingsWriter(ctx.env.db).capabilityEnabled(scope.projectId, 'cortex')]);
  const timings = new ContextTimings();
  const started = performance.now();
  const preview = await previewPromptItems(ctx.env.db, scope, leaves.injection, capabilityOn, { prompt, now: ctx.now }, () => resolveSemanticSearch(ctx.env), timings);
  const tookMs = round(performance.now() - started);
  return {
    project_id: scope.projectId,
    recorded: false,
    skipped: preview.skipped,
    attached: preview.attached.map((item, index) => ({ rank: index + 1, kind: item.kind, id: item.id, label: item.label, line: item.text,
      ...(item.score === null ? {} : { mutual_proximity: round(item.score.mp), similarity: round(item.score.similarity) }) })),
    left_out: preview.leftOut.map((item) => ({ id: item.id, reason: item.reason, mutual_proximity: round(item.mp), similarity: round(item.similarity) })),
    cut: preview.cut === null ? null : { probability: round(preview.cut.probability), separation: preview.cut.separation === null ? null : round(preview.cut.separation) },
    context: preview.context,
    counts: snake(preview.counts),
    took_ms: tookMs,
    stage_ms: Object.fromEntries(Object.entries(timings.stages()).map(([stage, ms]) => [stage, round(ms)])),
  };
}
