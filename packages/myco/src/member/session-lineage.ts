import { MAX_ID_CHARS } from '@goondocks/myco-shared/member-protocol';
import { sessionLineage } from './transcript.js';

/** OpenTelemetry's environment-variable carrier for W3C Baggage. */
export const BAGGAGE_ENV = 'BAGGAGE';
/** The conversation id a launcher places in its child's baggage. */
export const LAUNCH_PARENT_BAGGAGE_KEY = 'gen_ai.conversation.id';

/** W3C list-member grammar: token keys, ASCII baggage octets and optional properties. */
const BAGGAGE_MEMBER = /^[ \t]*([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]*=[ \t]*([\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*)[ \t]*(?:;[ \t]*[!#$%&'*+.^_`|~0-9A-Za-z-]+[ \t]*(?:=[ \t]*[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*[ \t]*)?)*$/;

/** A session id as a launcher can name one: no whitespace or control characters. */
const SESSION_ID_SHAPE = /^[^\s\p{Cc}]+$/u;

/** A session's two parents as `session.start` carries them: the predecessor a continuation transcript names, and the session that launched it. */
export interface SessionLineageFacts {
  parentSessionId?: string;
  parentReason?: string;
  launchParentSessionId?: string;
}

/**
 * The launching conversation named in valid baggage, within the wire bound and distinct from this session.
 * Malformed or conflicting baggage supplies no launch parent.
 */
export function launchParentSession(sessionId: string, env: NodeJS.ProcessEnv): string | undefined {
  const baggage = env[BAGGAGE_ENV];
  if (baggage === undefined || baggage === '') return undefined;
  let named: string | undefined;
  for (const member of baggage.split(',')) {
    const match = BAGGAGE_MEMBER.exec(member);
    if (match === null) return undefined;
    if (match[1] !== LAUNCH_PARENT_BAGGAGE_KEY) continue;
    let value: string;
    try { value = decodeURIComponent(match[2]!); }
    catch { return undefined; }
    if (named !== undefined && named !== value) return undefined;
    named = value;
  }
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
