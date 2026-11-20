import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { invocationsForSession, type InvocationCursor } from '../core/telemetry-invocations.js';
import { badRequest, notFound, resolveProjectScope, sessionInScope } from './scope.js';

/** Project-scoped exact invocation reports retain their own sender times. */
export async function handleSessionInvocations(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(ctx.params.sessionId);
  } catch {
    return notFound();
  }
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null || !(await sessionInScope(env.db, scope, sessionId))) return notFound();
  const raw = ctx.url.searchParams.get('cursor');
  let cursor: InvocationCursor | undefined;
  if (raw !== null) {
    const parts = /^(0|[1-9]\d*):([0-9a-f]{32}):([0-9a-f]{16}):(tk_[A-Za-z0-9_-]{16})$/.exec(raw);
    if (parts === null || !Number.isSafeInteger(Number(parts[1])))
      return badRequest('malformed invocation cursor; request the first page without cursor');
    cursor = { startAt: Number(parts[1]), traceId: parts[2]!, spanId: parts[3]!, keyId: parts[4]! };
  }
  const page = await invocationsForSession(env.db, scope.projectId, sessionId, cursor);
  return Response.json({
    rows: page.rows,
    nextCursor:
      page.nextCursor === null
        ? null
        : [
            page.nextCursor.startAt,
            page.nextCursor.traceId,
            page.nextCursor.spanId,
            page.nextCursor.keyId,
          ].join(':'),
  });
}
