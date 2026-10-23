/**
 * `myco_outcomes` over what sessions reported they created.
 *
 * `report` records one pull request, issue, tag, release or deploy against the caller's own session, the session the
 * prompt hook named to its agent: `sessionOf` admits only a session the addressed Project holds under the caller's
 * machine and has not deleted. The write lands through `reportSessionArtifact`, the one writer, which admits the kind, id
 * and URL; the same report again answers the stored row, and the same artifact under a different URL is refused. `list` reads one session's reports
 * through `listSessionArtifacts`, the read the dashboard serves.
 */
import { reportSessionArtifact } from '../../core/session-artifacts.js';
import { listSessionArtifacts, shape } from '../../read/session-artifacts.js';
import { sessionInScope } from '../../read/sessions.js';
import { failure, memberOf, scopeOf, sessionOf, writerOf, SESSION_NOT_FOUND, type ToolContext } from '../context.js';
import { snake } from '../shape.js';
import type { ToolInput } from '../validate.js';

export const OUTCOMES_TOOL = 'myco_outcomes';

export const ARTIFACT_CONFLICT_REASON = 'this artifact was already reported for this session with a different url';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);

export async function handleOutcomes(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const scope = await scopeOf(ctx, input);
  if (scope === null) return failure('Project not found');
  const { db } = ctx.env;
  const op = input.op ?? 'list';

  if (op === 'report') {
    memberOf(ctx, OUTCOMES_TOOL);
    if (str(input.session_id) === undefined) return failure('session_id is required for op: report');
    const session = await sessionOf(ctx, scope, input, OUTCOMES_TOOL);
    if (!session.ok) return session;
    if (session.sessionId === null) return failure(SESSION_NOT_FOUND);
    const reported = await reportSessionArtifact(db, scope, {
      sessionId: session.sessionId, kind: input.kind, artifactId: input.artifact_id, url: input.url, author: writerOf(ctx, OUTCOMES_TOOL).author, reportedAt: ctx.now,
    });
    if (reported.outcome === 'refused') return failure(reported.reason);
    if (reported.outcome === 'no_session') return failure(SESSION_NOT_FOUND);
    if (reported.outcome === 'conflict') return failure(ARTIFACT_CONFLICT_REASON);
    return { ...snake<Record<string, unknown>>(shape(reported.artifact)), session_id: session.sessionId, created: reported.outcome === 'created' };
  }

  const sessionId = str(input.session_id);
  if (sessionId === undefined) return failure('session_id is required for op: list');
  if (!(await sessionInScope(db, scope, sessionId))) return failure(SESSION_NOT_FOUND);
  const listed = await listSessionArtifacts(db, scope, sessionId, { limit: int(input.limit), cursor: str(input.cursor) });
  if (listed === null) return failure('malformed cursor');
  return { artifacts: listed.rows.map((row) => snake<Record<string, unknown>>(row)), cursor: listed.cursor };
}
