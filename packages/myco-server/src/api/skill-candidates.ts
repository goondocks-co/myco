import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { CANDIDATE_REVIEW_STATUSES, CANDIDATE_STATUSES, listCandidates, reviewCandidate, type CandidateReviewStatus } from '../core/skills.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const integer = (value: string | null, fallback: number): number => value === null ? fallback : /^\d+$/.test(value) ? Number(value) : NaN;

export async function handleSkillCandidates(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const status = ctx.url.searchParams.get('status') ?? undefined;
  const limit = integer(ctx.url.searchParams.get('limit'), DEFAULT_LIMIT);
  const offset = integer(ctx.url.searchParams.get('offset'), 0);
  if ((status !== undefined && !(CANDIDATE_STATUSES as readonly string[]).includes(status))
    || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIMIT || !Number.isSafeInteger(offset) || offset < 0) {
    return badRequest('Use a known candidate status, a limit from 1 to 100, and a nonnegative offset.');
  }
  const rows = await listCandidates(env.db, scope, { status, limit: limit + 1, offset });
  return ok({ candidates: rows.slice(0, limit), hasMore: rows.length > limit, offset, limit });
}

export async function handleReviewSkillCandidate(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const body = await readJsonObject(ctx.request);
  if (body === null || !Number.isSafeInteger(body.revision) || (body.revision as number) < 0
    || !(CANDIDATE_REVIEW_STATUSES as readonly unknown[]).includes(body.status)) {
    return badRequest('A current candidate revision and an approved, deferred, dismissed, or identified status are required.');
  }
  const result = await reviewCandidate(env.db, scope, { id: ctx.params.candidateId,
    revision: body.revision as number, status: body.status as CandidateReviewStatus, memberId: ctx.member.id }, ctx.now);
  if (result.candidate === null) return notFound();
  if (result.issues) return Response.json({ error: 'candidate_quality', reason: 'This candidate needs complete, resolvable evidence before approval.', issues: result.issues }, { status: 400 });
  if (!result.reviewed) return Response.json({ error: 'conflict', reason: 'This candidate changed or has already generated a skill. Reload it before reviewing.', candidate: result.candidate }, { status: 409 });
  return ok(result);
}
