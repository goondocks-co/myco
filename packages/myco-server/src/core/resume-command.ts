/**
 * The command that resumes a session in the agent that captured it, from that agent's symbiont manifest.
 *
 * The manifests are the one source: `gen-hook-config.ts` carries each `resumeCommand` into myco-shared, and the
 * Deployment fills in the session. A session id is whatever the capturing member sent, and the command is pasted into
 * a shell, so an id that is not a plain token (letters, digits, `.`, `_`, `-`) gets no command rather than one that
 * would run something else.
 */
import { RESUME_COMMANDS } from '@goondocks/myco-shared/resume-commands-data';

const PLAIN_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;

/** The resume command for a session of `agent`, or null when the agent's manifest names none or the id is not a plain token. */
export function resumeCommandFor(agent: string | null, sessionId: string): string | null {
  const template = agent === null ? undefined : RESUME_COMMANDS[agent];
  if (template === undefined || !PLAIN_TOKEN.test(sessionId)) return null;
  return template.replaceAll('{sessionId}', sessionId);
}
