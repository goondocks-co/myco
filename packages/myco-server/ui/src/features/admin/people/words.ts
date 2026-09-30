/**
 * People & machines in words: every sentence the pages show about members,
 * invitations and machines, from what the server answers. None names an id.
 */
import { JOIN_PATH } from '@goondocks/myco-shared/member-protocol';
import { formatUntil } from '../../../lib/format';
import type { Machine } from '../machines';

/** How long a new invitation works, as the dialogs offer it. The server takes 1 to 1440 minutes. */
export const VALIDITY_OPTIONS = [
  { value: '60', label: 'For an hour' },
  { value: '1440', label: 'For a day' },
] as const;

export const DEFAULT_VALIDITY = '60';

/** The command that redeems an invitation, run on the machine joining. */
export function loginCommand(key: string, origin: string = window.location.origin): string {
  return `myco login ${origin}${JOIN_PATH}#${key}`;
}

/** When an open invitation stops working. The list holds only unexpired ones, so a past one has lapsed since it loaded. */
export function invitationExpiry(expiresAt: number, now: number): string {
  return expiresAt <= now ? 'expired' : `expires in ${formatUntil(expiresAt, now)}`;
}

/** A day as a person says it on a list: "Sep 3", with the year when it is not this one. */
export function shortDate(at: number, now: number = Date.now()): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
}

/** "1 machine", "3 machines". */
export function machinesCount(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? 'machine' : 'machines'}`;
}

/**
 * Where a machine stands, from its credentials' own record: whether one would
 * authenticate now, never whether it is writing. `stoppedByName` names the
 * member who stopped it, or is null when the page can't name them.
 */
export function standingWords(machine: Pick<Machine, 'standing'>, stoppedByName: string | null): string {
  switch (machine.standing) {
    case 'allowed': return 'allowed to write';
    case 'replayed': return 'stopped: used from two places';
    case 'stopped': return stoppedByName === null ? 'stopped' : `stopped by ${stoppedByName}`;
    case 'expired': return 'expired';
  }
}

/** What a captured event is, in the person's words. */
export const KIND_WORDS: Readonly<Record<string, string>> = {
  'session.start': 'Session started', 'session.end': 'Session ended', prompt: 'Prompt', 'tool.use': 'Tool call', 'tool.failure': 'Tool failed',
  response: 'Reply', plan: 'Plan', attachment: 'Attachment', 'transcript.segment': 'Transcript', 'compaction.pre': 'Compaction', 'compaction.post': 'Compaction',
  'subagent.start': 'Subagent started', 'subagent.stop': 'Subagent stopped', 'stop.failure': 'Stop failed', 'task.completed': 'Task completed', notification: 'Notification', error: 'Error',
};

export const kindWords = (kind: string): string => KIND_WORDS[kind] ?? 'Something else';
