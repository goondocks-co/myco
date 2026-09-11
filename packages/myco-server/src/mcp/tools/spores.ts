/**
 * `myco_spores` over the Deployment's spores.
 *
 * Reads and writes go through `core/spores.ts`, the same functions the harness
 * routes use. A write carries the principal behind it (`writerOf`): a member's
 * spore the built-in `user` agent and the member as author, as it does in 1.4
 * plus the author; a run's its agent and the run as author; an External Agent
 * grant's its own agent row and the grant as author. Every resolution is one
 * atomic write of the status and its event. New extraction spores name a
 * captured source prompt in the run's Project. Other writes use `sessionOf`:
 * a member's own machine's session, a run's dispatch-named one, and no session
 * for a grant.
 *
 * A write that names no session may cite what produced it instead — a pull
 * request or a commit — which is the only provenance an externally hosted agent
 * has. Every one of the four writes parses the citation and carries it: a kind
 * without a ref never reaches the store, and no op accepts a citation it would
 * then drop.
 */
import { consolidateSpores, countSpores, getSpore, insertSpore, listSpores, listSupersededSporeIds, listSupersedingSporeIds, resolveSpore, type ResolutionAction, type SporeProvenance, type SporeRow, type SporeStatus } from '../../core/spores.js';
import { mintSporeId, overSporeCap, planSporeConsolidation, planSporeResolution, SPORE_CAP_REASON, sporeTags } from '../../core/spore-writes.js';
import { latestPromptId } from '../../read/sessions.js';
import { extractionSourceSession } from '../../read/prompts.js';
import { promptInSession } from '../../read/turns.js';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import { AGENT_LINE_MAX_CHARS } from '../../core/injection.js';
import type { ReadScope } from '../../read/scope.js';
import { failure, scopeOf, sessionOf, writerOf, SESSION_NOT_FOUND, type ToolContext, type ToolFailure } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

const TOOL = 'myco_spores';

/** A spore as this principal reads it: the row entire for a member or a run; without `author` for an External Agent grant, which is told who wrote nothing. */
function visible(ctx: ToolContext, row: SporeRow): Record<string, unknown> {
  const shaped = snake<Record<string, unknown>>(row);
  if (ctx.principal.kind === 'grant') delete shaped.author;
  return shaped;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

/** The captured source of a new spore; extraction names its exact prompt instead of a dispatch session. */
async function sourceOf(input: ToolInput, ctx: ToolContext, scope: ReadScope): Promise<{ ok: true; sessionId: string | null; promptId: string | null } | ToolFailure> {
  const promptId = str(input.prompt_id);
  if (ctx.principal.kind === 'run' && ctx.principal.task === EXTRACTION_TASK) {
    if (promptId === undefined) return failure('prompt_id is required for extraction spore writes');
    const sessionId = await extractionSourceSession(ctx.env.db, scope, promptId);
    if (sessionId === null) return failure('prompt_id not found');
    const named = str(input.session_id);
    if ((named !== undefined && named !== sessionId) || (ctx.principal.sessionId !== null && ctx.principal.sessionId !== sessionId)) return failure(SESSION_NOT_FOUND);
    return { ok: true, sessionId, promptId };
  }
  const session = await sessionOf(ctx, scope, input, TOOL);
  if (!session.ok) return session;
  if (input.prompt_id !== undefined && (promptId === undefined || session.sessionId === null || !(await promptInSession(ctx.env.db, scope, session.sessionId, promptId)))) return failure('prompt_id not found');
  return { ...session, promptId: promptId ?? (session.sessionId === null ? null : await latestPromptId(ctx.env.db, scope, session.sessionId)) };
}

const PROVENANCE_KINDS: ReadonlySet<string> = new Set(['pr', 'commit']);
/** One refusal for an agent line past the bound the injection renders. */
const AGENT_LINE_REASON = `agent_line is at most ${AGENT_LINE_MAX_CHARS} characters`;

/** The agent line a write carries, null where it carries none, or the one thing wrong with it. */
function agentLineOf(input: ToolInput): { ok: true; agentLine: string | null } | ToolFailure {
  const line = str(input.agent_line);
  if (line === undefined) return { ok: true, agentLine: null };
  const oneLine = line.replace(/\s+/g, ' ').trim();
  if (oneLine.length === 0 || oneLine.length > AGENT_LINE_MAX_CHARS) return failure(AGENT_LINE_REASON);
  return { ok: true, agentLine: oneLine };
}
const COMMIT_REF = /^[0-9a-f]{7,40}$/;
const PROVENANCE_REF_MAX = 512;
/** One refusal for every malformed citation, so a caller learns the shape and nothing about the store. */
const PROVENANCE_REASON = 'provenance_kind and provenance_ref are given together: kind "pr" with an https URL, or kind "commit" with a sha';

/** What a write cites in place of a session, none, or the one thing wrong with the citation. */
function provenanceOf(input: ToolInput): { ok: true; provenance: SporeProvenance | null } | ToolFailure {
  const kind = str(input.provenance_kind);
  const ref = str(input.provenance_ref);
  if (kind === undefined && ref === undefined) return { ok: true, provenance: null };
  if (kind === undefined || ref === undefined || !PROVENANCE_KINDS.has(kind)) return failure(PROVENANCE_REASON);
  if (new TextEncoder().encode(ref).byteLength > PROVENANCE_REF_MAX) return failure(PROVENANCE_REASON);
  if (kind === 'commit' && !COMMIT_REF.test(ref)) return failure(PROVENANCE_REASON);
  if (kind === 'pr' && !ref.startsWith('https://')) return failure(PROVENANCE_REASON);
  return { ok: true, provenance: { kind: kind as SporeProvenance['kind'], ref } };
}

async function resolve(
  ctx: ToolContext, scope: ReadScope, sporeId: string, status: SporeStatus, action: ResolutionAction,
  newSporeId: string | null, reason: string | null, sessionId: string | null, provenance: SporeProvenance | null,
): Promise<boolean> {
  const by = writerOf(ctx, TOOL);
  return resolveSpore(ctx.env.db, scope, status, {
    id: crypto.randomUUID(), agentId: by.agentId, author: by.author, sporeId, action, newSporeId, reason, sessionId, provenance, createdAt: ctx.now,
  }, ctx.now);
}

export async function handleSpores(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';

  if (op === 'get') {
    const id = str(input.id);
    if (id === undefined) return failure('id is required for op: get');
    const spore = await getSpore(db, scope, id);
    if (spore === null) return failure('Spore not found');
    const [supersededBy, predecessors] = await Promise.all([
      listSupersedingSporeIds(db, scope, id),
      listSupersededSporeIds(db, scope, id),
    ]);
    return { ...visible(ctx, spore), superseded_by: supersededBy, predecessors };
  }

  if (op === 'save') {
    const content = str(input.content);
    const type = str(input.type);
    if (content === undefined) return failure('content is required for op: save');
    if (type === undefined) return failure('type is required for op: save');
    if (overSporeCap(content)) return failure(SPORE_CAP_REASON);
    const by = writerOf(ctx, TOOL);
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const lined = agentLineOf(input);
    if (!lined.ok) return lined;
    const session = await sourceOf(input, ctx, scope);
    if (!session.ok) return session;
    const spore = await insertSpore(db, scope, {
      id: mintSporeId(type), agentId: by.agentId, sessionId: session.sessionId, promptId: session.promptId, observationType: type,
      content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null,
      author: by.author, provenance: cited.provenance, agentLine: lined.agentLine, createdAt: ctx.now,
    });
    if (spore === null) return failure('Spore was not recorded');
    return { id: spore.id, observation_type: spore.observationType, status: spore.status, created_at: spore.createdAt };
  }

  if (op === 'supersede') {
    const planned = await planSporeResolution(db, scope, {
      action: 'supersede', sporeId: str(input.old_spore_id), newSporeId: str(input.new_spore_id), reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    if (!(await resolve(ctx, scope, plan.sporeId, plan.status, 'supersede', plan.newSporeId, plan.reason, session.sessionId, cited.provenance))) return failure('old_spore_id not found');
    return { old_spore: plan.sporeId, new_spore: plan.newSporeId, status: plan.status };
  }

  if (op === 'obsolete') {
    const planned = await planSporeResolution(db, scope, { action: 'obsolete', sporeId: str(input.id), reason: str(input.reason) });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const session = await sessionOf(ctx, scope, input, TOOL);
    if (!session.ok) return session;
    if (!(await resolve(ctx, scope, plan.sporeId, plan.status, 'obsolete', null, plan.reason, session.sessionId, cited.provenance))) return failure('spore_id not found');
    return { spore: plan.sporeId, status: plan.status };
  }

  if (op === 'consolidate') {
    const planned = await planSporeConsolidation(db, scope, {
      sources: Array.isArray(input.source_spore_ids) ? input.source_spore_ids.map(String) : [],
      content: str(input.consolidated_content),
      observationType: str(input.observation_type),
      reason: str(input.reason),
    });
    if (!planned.ok) return failure(planned.reason);
    const plan = planned.plan;
    const by = writerOf(ctx, TOOL);
    const cited = provenanceOf(input);
    if (!cited.ok) return cited;
    const lined = agentLineOf(input);
    if (!lined.ok) return lined;
    const session = await sourceOf(input, ctx, scope);
    if (!session.ok) return session;
    const { wisdom, consolidated } = await consolidateSpores(db, scope, {
      id: mintSporeId(plan.observationType), agentId: by.agentId, sessionId: session.sessionId, promptId: session.promptId, observationType: plan.observationType,
      content: plan.content, context: null, filePath: null, tags: sporeTags(input.tags), contentHash: null, properties: null,
      author: by.author, provenance: cited.provenance, agentLine: lined.agentLine, createdAt: ctx.now,
    }, plan.sources, { agentId: by.agentId, author: by.author, reason: plan.reason, sessionId: session.sessionId, provenance: cited.provenance, createdAt: ctx.now }, ctx.now);
    if (wisdom === null) return failure('Consolidated spore was not recorded');
    return { new_spore_id: wisdom.id, sources_consolidated: consolidated, status: 'consolidated', created_at: wisdom.createdAt };
  }

  const options = {
    agentId: str(input.agent_id),
    observationType: str(input.observation_type) ?? str(input.type),
    status: str(input.status) === 'all' ? undefined : str(input.status),
    search: str(input.search),
    limit: int(input.limit),
    offset: int(input.offset),
  };
  const [spores, total] = await Promise.all([listSpores(db, scope, options), countSpores(db, scope, options)]);
  return { spores: spores.map((s: SporeRow) => visible(ctx, s)), total, offset: options.offset ?? 0, limit: options.limit };
}
