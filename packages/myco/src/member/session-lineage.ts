import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';
import { sessionLineage } from './transcript.js';

/** The environment variable a launcher sets on the harness it starts: the id of the session that launched it. */
export const PARENT_SESSION_ENV = 'MYCO_PARENT_SESSION';

/** A session id as a launcher can name one: no whitespace or control characters. */
const SESSION_ID_SHAPE = /^[^\s\p{Cc}]+$/u;

/** A session's two parents as `session.start` carries them: the predecessor a continuation transcript names, and the session that launched it. */
export interface SessionLineageFacts {
  parentSessionId?: string;
  parentReason?: string;
  launchParentSessionId?: string;
}

/** The launching session `PARENT_SESSION_ENV` names, when the value is a session id within the wire bound and not the session itself. */
export function launchParentSession(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  const named = env[PARENT_SESSION_ENV];
  if (named === undefined || named.length > MAX_ID_CHARS || !SESSION_ID_SHAPE.test(named) || named === sessionId) return undefined;
  return named;
}

/** The lineage facts of a starting session, each read once from where it is declared: the transcript and the harness environment. */
export function sessionLineageFacts(agent: string, sessionId: string, transcriptPath: string | undefined, env: NodeJS.ProcessEnv): SessionLineageFacts {
  const continuation = sessionLineage(agent, sessionId, transcriptPath);
  return {
    parentSessionId: continuation?.parentSessionId,
    parentReason: continuation?.parentReason,
    launchParentSessionId: launchParentSession(sessionId, env),
  };
}
