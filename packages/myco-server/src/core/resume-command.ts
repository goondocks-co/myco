/**
 * How to resume a session in the agent that captured it, from that agent's symbiont manifest.
 *
 * The manifests are the one source: `gen-hook-config.ts` carries each `resumeCommand` into myco-shared, and the
 * Deployment fills in the session. Everything here is pasted into a shell, and the agent, the session id and the
 * folder all came from the capturing member, so:
 * - an agent is looked up as the catalogue's own key, never an inherited one (`constructor`, `__proto__`);
 * - a session id that is not a plain token (letters, digits, `.`, `_`, `-`, at most 128) gets nothing, and neither
 *   does an id 1.4 minted (`sess_…`), which no agent can resume;
 * - the folder is quoted for the shell that reads it: POSIX single quotes, or PowerShell's for a Windows path. A
 *   folder carrying a control character gets nothing.
 */
import { RESUME_COMMANDS } from '@goondocks/myco-shared/resume-commands-data';
import { LEGACY_MINTED_ID } from '@goondocks/myco-shared/session-ids';

const PLAIN_TOKEN = /^[A-Za-z0-9._-]{1,128}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** A path a Windows shell names: a drive (`C:\`, `C:/`) or a share (`\\host\share`). */
const WINDOWS_PATH = /^(?:[A-Za-z]:[\\/]|\\\\)/;

/** How to resume one session: the agent's command, and the line to paste, which enters the session's folder first when it recorded one. */
export interface ResumeCommand {
  command: string;
  line: string;
}

/** A POSIX shell word: the text in single quotes, each quote in it closed, escaped and reopened. */
const posixQuoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
/** A PowerShell literal string: the text in single quotes, each quote in it doubled. */
const powershellQuoted = (text: string): string => `'${text.replaceAll("'", "''")}'`;

/** How to resume a session of `agent`, begun in `originPath`; null when the agent names no command or the session or folder cannot be pasted safely. */
export function resumeCommandFor(agent: string | null, sessionId: string, originPath: string | null): ResumeCommand | null {
  if (agent === null || !Object.hasOwn(RESUME_COMMANDS, agent)) return null;
  if (!PLAIN_TOKEN.test(sessionId) || LEGACY_MINTED_ID.test(sessionId)) return null;
  const command = RESUME_COMMANDS[agent]!.replaceAll('{sessionId}', sessionId);
  if (originPath === null || originPath === '') return { command, line: command };
  if (CONTROL_CHARACTERS.test(originPath)) return null;
  return {
    command,
    line: WINDOWS_PATH.test(originPath)
      ? `Set-Location -LiteralPath ${powershellQuoted(originPath)}; ${command}`
      : `cd ${posixQuoted(originPath)} && ${command}`,
  };
}
