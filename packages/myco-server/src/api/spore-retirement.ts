/**
 * A person retires a current spore, or restores one retired with nothing in its place, from the dashboard.
 *
 * Each is the lifecycle write `myco_spores` makes (`core/spore-admission.ts`), recorded as the signed-in member's and bound to the revision
 * the page read: a page showing a spore that has changed since is refused with a conflict and nothing is changed. Each answers the spore
 * as it stands afterwards, as `GET /api/projects/{p}/spores/{id}` does.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import type { ReadScope } from '../read/scope.js';
import { restoreSporeWrite, writeSpore } from '../core/spore-admission.js';
import { badRequest, notFound, ok, parseJsonObject, resolveProjectScope } from './scope.js';
import { sporeArticle } from './intelligence.js';

/** The page's spore moved since it was read: reload it and decide again. */
const SPORE_CHANGED = 'spore_changed';
/** The spore was replaced or merged, so it reads its replacement and has nothing to restore. */
const SPORE_REPLACED = 'spore_replaced';
const REPLACED_STATUSES: ReadonlySet<string> = new Set(['superseded', 'consolidated']);

const CHANGED_MESSAGE = 'This spore changed after the page showed it, and nothing was changed. Reload the page and try again.';
const REPLACED_MESSAGE = 'This spore was replaced, so it cannot be restored, and nothing was changed. Read what replaced it instead.';
const REVISION_REQUIRED = 'revision is required: send the revision of the spore the page showed.';
const REASON_REQUIRED = 'A reason is required to retire a spore, and nothing was changed. Say why it no longer holds.';

type Outcome = Record<string, unknown> & { ok?: false; error?: unknown; status?: unknown; revision?: unknown };

interface ChangeRequest { scope: ReadScope; sporeId: string; body: Record<string, unknown>; revision: number }

/** The Project, the spore and the revision the page read, or the answer that refuses the request. */
async function requestOf(env: ServerEnv, ctx: OwnerContext): Promise<ChangeRequest | Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId ?? '');
  if (scope === null) return notFound();
  const body = parseJsonObject(await ctx.request.text()) ?? {};
  const revision = body.revision;
  if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) return badRequest(REVISION_REQUIRED);
  return { scope, sporeId: ctx.params.sporeId ?? '', body, revision };
}

/**
 * The write's outcome as the dashboard reads it: the spore as it stands, or the refusal a person can act on. A restore of a replaced spore is
 * refused as replaced; every other stale spore, a retirement's included, changed after the page read it.
 */
async function answer(env: ServerEnv, scope: ReadScope, sporeId: string, outcome: Outcome, change: 'retire' | 'restore'): Promise<Response> {
  if (outcome.ok === false) {
    if (outcome.error === 'spore_id not found') return notFound();
    if (outcome.error !== 'stale') return badRequest(String(outcome.reason ?? outcome.error));
    const replaced = change === 'restore' && typeof outcome.status === 'string' && REPLACED_STATUSES.has(outcome.status);
    return Response.json({ error: replaced ? SPORE_REPLACED : SPORE_CHANGED, message: replaced ? REPLACED_MESSAGE : CHANGED_MESSAGE,
      status: outcome.status, revision: outcome.revision }, { status: 409 });
  }
  const article = await sporeArticle(env, scope, sporeId);
  return article === null ? notFound() : ok(article);
}

const memberOf = (ctx: OwnerContext) => ({ kind: 'member' as const, memberId: ctx.member.id, machineId: null });

/** `POST …/spores/{sporeId}/retire` with `{ reason, revision }`: retire a current spore with the reason the person gave. */
export async function handleRetireSpore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const request = await requestOf(env, ctx);
  if (request instanceof Response) return request;
  const reason = typeof request.body.reason === 'string' ? request.body.reason.trim() : '';
  if (reason === '') return badRequest(REASON_REQUIRED);
  const outcome = await writeSpore(
    { op: 'obsolete', id: request.sporeId, reason, expect_status: 'active', expect_revision: request.revision },
    { env, projectId: request.scope.projectId, now: ctx.now, principal: memberOf(ctx) },
  ) as Outcome;
  return answer(env, request.scope, request.sporeId, outcome, 'retire');
}

/** `POST …/spores/{sporeId}/restore` with `{ revision }`: return a spore retired with nothing in its place to the current spores. */
export async function handleRestoreSpore(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const request = await requestOf(env, ctx);
  if (request instanceof Response) return request;
  const outcome = await restoreSporeWrite(
    { id: request.sporeId, expect_revision: request.revision },
    { env, projectId: request.scope.projectId, now: ctx.now, principal: memberOf(ctx) },
  ) as Outcome;
  return answer(env, request.scope, request.sporeId, outcome, 'restore');
}
