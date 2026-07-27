/**
 * "Is the operation that took this lease still unfinished?" (write-admission W4)
 *
 * The other half of derived held-ness. A lease is held while its holder is
 * alive OR its operation is unfinished; this module answers the second half.
 * It is load-bearing rather than belt-and-braces: a residency transition is
 * designed to SURVIVE a daemon restart (that is what its journal is for), so
 * holder-liveness alone would unblock a project whose move is half-done and
 * about to resume.
 *
 * Evidence is DATA — a path plus a rule for reading it — never a call into
 * the module that owns the operation. That is deliberate:
 *
 *   - `grove/` would otherwise have to import `host/`, inverting the layering;
 *   - a resolver registry would need every process that reads a lease to
 *     register the resolvers first, and the CLI and hook paths read leases
 *     too, so a missed registration would silently change the answer;
 *   - as data, the record is self-describing: whoever finds a lease file can
 *     tell what is holding it without running Myco.
 *
 * Adding a lease-taking operation means adding a `kind` here and a rule for
 * reading its record — not editing the lease's own logic.
 */

import { readFilePresence } from '@myco/utils/presence.js';

/**
 * A pointer to the durable record the operation itself maintains.
 *
 * `null` is a legitimate value, not a gap: an operation with no crash-
 * resumable record (a short synchronous one, or a test) is governed by
 * holder-liveness alone. Making it an explicit choice at the call site is
 * the point — a new lease-taking operation has to say which it is.
 */
export type LeaseEvidence =
  | {
      /**
       * A residency transition journal (`<teamsHome>/residency/<projectId>.json`).
       * Unfinished while its `phase` is anything other than `done`.
       */
      kind: 'residency-journal';
      path: string;
    }
  | {
      /**
       * A `grove move` marker (`<vaultDir>/migration/<moveOpId>.json`).
       * Unfinished while its `phase` is neither `completed` nor `failed`.
       *
       * Existence is NOT the signal, though it reads like it should be: the
       * move never deletes this file. Terminal markers are retained
       * deliberately — `findCompletedMarkerForProject` reads a `completed`
       * one back to serve the idempotent-return path, and
       * `findExistingMarkerForProject` skips terminal phases when deciding
       * whether a move can resume. Treating existence as in-flight would
       * make every grove-move lease permanently held.
       */
      kind: 'move-marker';
      path: string;
    };

/**
 * Is the operation still unfinished?
 *
 * Fails CLOSED on every uncertainty (G4): an unreadable record, or a journal
 * whose contents will not parse, counts as unfinished and keeps the project
 * blocked. Only a record that is definitively ABSENT — or definitively
 * terminal — releases it. Treating an unreadable journal as finished would
 * free a project mid-move on a transient read error, which is the one
 * outcome this whole mechanism exists to prevent.
 */
export function isOperationUnfinished(evidence: LeaseEvidence): boolean {
  const file = readFilePresence(evidence.path);
  if (file.state === 'absent') return false;
  if (file.state === 'unknown') return true;

  // Both kinds are phase-bearing JSON; they differ only in which phases are
  // terminal. A parse failure is never treated as terminal — a torn record
  // cannot prove the operation finished.
  let phase: unknown;
  try {
    phase = (JSON.parse(file.value) as { phase?: unknown }).phase;
  } catch {
    return true;
  }
  return evidence.kind === 'move-marker'
    ? !MOVE_TERMINAL_PHASES.has(phase as string)
    : phase !== 'done';
}

/**
 * Mirrors `TERMINAL_PHASES` in `grove/move.ts`. Duplicated rather than
 * imported to keep `lease-evidence` free of a dependency on the operations it
 * describes — the same reason evidence is data. Pinned by
 * `tests/grove/project-lease-liveness.test.ts` so the two cannot drift apart
 * silently.
 */
const MOVE_TERMINAL_PHASES: ReadonlySet<string> = new Set(['completed', 'failed']);
