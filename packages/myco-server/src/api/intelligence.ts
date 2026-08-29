/**
 * The generated intelligence, read through the product surface.
 *
 * The member routes under `/spores` and `/runs` serve the harness that produces
 * this; these serve the people who read it. Same rows, different callers, and
 * the distinction matters: a harness writes on behalf of one Project it was
 * dispatched for, while an owner browses across Projects they hold.
 *
 * **An empty answer is not a missing one.** Every collection here answers `200`
 * with an empty list for a Project that has generated nothing yet, and `404`
 * only when the Project itself is not one this caller may see. A surface that
 * conflated them would make "the task has not run" indistinguishable from "the
 * task does not exist", which is exactly the report an operator needs when
 * intelligence stops appearing.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { notFound, ok, resolveProjectScope } from './scope.js';
import { countSpores, getSpore, listSpores, listSupersedingSporeIds } from '../core/spores.js';
import { getPublishedSkillContent, listLineageForSkill, listSkillRecords } from '../core/skills.js';
import { listDigestRevisions, listDigests } from '../core/digests.js';
import { listReleaseStates } from '../core/provenance.js';

/** The largest page this surface serves, whatever a caller asks for. */
export const MAX_PAGE = 200;

const clampLimit = (raw: string | null): number => {
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? Math.min(n, MAX_PAGE) : 50;
};

/** Resolve the Project or answer 404. A Project the caller does not hold is indistinguishable from one that does not exist. */
async function scopeOf(env: ServerEnv, ctx: OwnerContext) {
  const projectId = ctx.params.projectId;
  return projectId === undefined ? null : await resolveProjectScope(env.db, ctx.member, projectId);
}

export async function handleProjectSpores(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const options = {
    observationType: ctx.url.searchParams.get('type') ?? undefined,
    status: ctx.url.searchParams.get('status') ?? undefined,
    search: ctx.url.searchParams.get('q') ?? undefined,
    limit: clampLimit(ctx.url.searchParams.get('limit')),
  };
  const [spores, total] = await Promise.all([
    listSpores(env.db, scope, options),
    countSpores(env.db, scope, options),
  ]);
  return ok({ spores, total, maxPage: MAX_PAGE });
}

/** One spore and what supersedes it, so a reader sees a retired spore's replacement rather than a dead end. */
export async function handleProjectSpore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const spore = await getSpore(env.db, scope, ctx.params.sporeId ?? '');
  if (spore === null) return notFound();
  return ok({ spore, supersededBy: await listSupersedingSporeIds(env.db, scope, spore.id) });
}

export async function handleProjectSkills(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  return ok({
    skills: await listSkillRecords(env.db, scope, {
      status: ctx.url.searchParams.get('status') ?? undefined,
      limit: clampLimit(ctx.url.searchParams.get('limit')),
    }),
  });
}

/**
 * A skill's published content and its lineage.
 *
 * The content comes from the latest lineage snapshot rather than the record:
 * `skill_records` carries metadata and a path, and the file on disk is a
 * materialization that a server has no copy of.
 */
export async function handleProjectSkill(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const skillId = ctx.params.skillId ?? '';
  const [content, lineage] = await Promise.all([
    getPublishedSkillContent(env.db, scope, skillId),
    listLineageForSkill(env.db, scope, skillId, clampLimit(ctx.url.searchParams.get('limit'))),
  ]);
  if (content === null && lineage.length === 0) return notFound();
  return ok({ content, lineage });
}

export async function handleProjectDigests(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  return ok({ digests: await listDigests(env.db, scope, ctx.url.searchParams.get('agentId') ?? undefined) });
}

/** The bodies a digest displaced, newest first — the history a replacement preserves rather than overwrites. */
export async function handleProjectDigestRevisions(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const agentId = ctx.url.searchParams.get('agentId');
  const tier = Number(ctx.params.tier);
  if (agentId === null || !Number.isSafeInteger(tier)) return notFound();
  return ok({ revisions: await listDigestRevisions(env.db, scope, agentId, tier, clampLimit(ctx.url.searchParams.get('limit'))) });
}

export async function handleProjectReleaseStates(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await scopeOf(env, ctx);
  if (scope === null) return notFound();
  const namespace = ctx.url.searchParams.get('namespace');
  return ok({
    releaseStates: await listReleaseStates(env.db, scope, {
      namespace: namespace === null ? undefined : namespace as never,
      state: ctx.url.searchParams.get('state') ?? undefined,
      limit: clampLimit(ctx.url.searchParams.get('limit')),
    }),
  });
}
