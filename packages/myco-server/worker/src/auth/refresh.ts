import type { Env } from '../env.js';
import type { RouteContext } from '../context.js';
import { emit, refusal, type Refusal } from '../telemetry.js';
import { refreshMemberToken, type RefreshResult } from './tokens.js';

/** The refresh body: an empty JSON object. A body that is not JSON, not an object, or carries a field is refused by name. */
function parseRefreshBody(body: string): Refusal | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return refusal('body must be JSON', 'parse');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return refusal('body must be an object');
  const [field] = Object.keys(parsed);
  return field === undefined ? null : refusal(`unknown field ${field}`, 'unknown_field');
}

/** Answers in the route's shape: a refusal is 200 `{refreshed:false, code, reason[, refreshAfter]}` with one `refresh_refused` event carrying the classifier only; a success is 200 `{refreshed:true, token, tokenId, expiresAt, refreshAfter}` with one `token_refreshed` event naming the successor and its predecessor by id. */
function answer(ctx: RouteContext, result: RefreshResult): Response {
  if (result.refreshed) {
    emit({ kind: 'token_refreshed', projectId: ctx.projectId, tokenId: result.tokenId, predecessorId: ctx.tokenId });
  } else {
    const classifier = result.code;
    emit({ kind: 'refresh_refused', projectId: ctx.projectId, tokenId: ctx.tokenId, reason: classifier });
  }
  return Response.json(result);
}

/** `POST /tokens/refresh`: the presented token asks for its successor. */
export async function handleRefresh(env: Env, ctx: RouteContext): Promise<Response> {
  const malformed = parseRefreshBody(ctx.body);
  if (malformed !== null) return answer(ctx, { refreshed: false, code: malformed.classifier, reason: malformed.reason });
  return answer(ctx, await refreshMemberToken(env.MYCO_DB, ctx, ctx.now));
}
