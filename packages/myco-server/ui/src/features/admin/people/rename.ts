/**
 * Renaming a machine: who may, what a name may be, and what a refusal says.
 *
 * A name is the rule `PATCH /api/machines/{id}` holds it to, checked here
 * first so a person is told before anything is sent: trimmed, 1 to 64
 * characters counted as characters, none of them a control, format,
 * private-use, unassigned or separator character, and no more than four marks
 * stacked on one letter. `tests/myco-server-ui/people.test.tsx` holds this
 * rule to the server's `machineName`.
 */
import { ApiError } from '../../../lib/api';
import type { Machine } from '../machines';

/** The longest name a machine takes, in characters. */
export const MACHINE_NAME_MAX = 64;

/** Control, format, surrogate, private-use and unassigned code points, and line and paragraph separators. */
const UNPRINTABLE = /[\p{C}\p{Zl}\p{Zp}]/u;
/** More combining marks in a row than any script writes on one letter. */
const STACKED_MARKS = /\p{M}{5,}/u;

/** What is wrong with `value` as a machine's name, in words; null when the server will take it. */
export function machineNameProblem(value: string): string | null {
  const name = value.trim();
  const length = [...name].length;
  if (length === 0) return 'Give the machine a name.';
  if (length > MACHINE_NAME_MAX) return `A name is at most ${MACHINE_NAME_MAX} characters; this one is ${length}.`;
  if (UNPRINTABLE.test(name)) return 'A name can’t hold control or invisible characters.';
  if (STACKED_MARKS.test(name)) return 'A name can’t stack more than four accents on one letter.';
  return null;
}

/**
 * Whether the viewer may rename this machine: an admin any machine, a member
 * only their own. A machine known only by a sign-in that named no machine has
 * nothing to rename.
 */
export function canRename(machine: Pick<Machine, 'machineId' | 'memberId'>, viewerId: string | null, admin: boolean): boolean {
  if (machine.machineId === null) return false;
  return admin || (viewerId !== null && machine.memberId === viewerId);
}

/** What to tell the person when the server refused a rename. */
export function renameRefusalWords(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 400) return `The server didn’t take that name. A name is 1 to ${MACHINE_NAME_MAX} characters, every one of them printable.`;
    if (err.status === 404) return 'This machine is no longer here, or it isn’t yours to rename.';
    return `The server refused (${err.status}).`;
  }
  return 'Could not reach the server.';
}
