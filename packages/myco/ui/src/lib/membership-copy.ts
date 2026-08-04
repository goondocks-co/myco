import { ApiError } from './api';
import type { ResidencyDirection, ResidencyPhase } from '../hooks/use-host-membership';

/** Direction-agnostic `residency_abort_too_late` line — the map entry and the
 *  `residencyAbortTooLateCopy` fallback share it so they never drift. */
const RESIDENCY_ABORT_TOO_LATE_GENERIC =
  "This move is too far along to cancel — it'll finish on its own in a moment.";

/**
 * Outcome copy for Team Host membership failures (copy doctrine,
 * decision-6a2ccfac) — mirrors the claims UI's `materializeErrorCopy`
 * pattern. The daemon API (`daemon/api/host-membership.ts`) carries the
 * orchestration's CLI-voiced message verbatim ("Run `myco detach`…",
 * "…requires the residency-transition migration… (task A2)"), which is right
 * for a terminal but wrong for a browser that has its own Detach button and
 * join form. Known failure CODES (`host/membership-error.ts`) map to copy
 * that references the UI's own affordances; anything uncoded falls back to
 * the raw message rather than hiding it.
 */
const MEMBERSHIP_ERROR_COPY: Record<string, string> = {
  project_registered_locally:
    "This project already has local Myco data on this machine — attaching a project with existing local history isn't available yet.",
  join_unavailable:
    'Joining a team is temporarily unavailable in this build while team connectivity is being rebuilt. Nothing was changed on this machine.',
  project_attached_to_other_host:
    'This project is already attached to another host. Detach it from that host first — its host card above has a Detach control.',
  not_joined:
    "This machine hasn't joined that host yet. Join it first using the form above, then attach.",
  protocol_mismatch:
    'This machine and the host are running different Myco versions. Update Myco on both, then try again.',
  host_enroll_rejected:
    "The host turned down this machine's request to join. Ask the host operator to confirm this machine is allowed, then try again.",
  host_enroll_failed:
    "Couldn't finish joining this host. It may be busy or set up incompletely — check with the host operator and try again.",
  host_predates_served_grove:
    "This host hasn't reported its team storage yet — update Myco on the host machine, then re-join and try attaching again.",
  attach_grove_mismatch:
    "This project's link points at team storage the host no longer serves. Detach and re-attach to route it to the host's current team storage.",
  unknown_local_grove:
    "That Grove doesn't exist on this machine. Pick one of your local Groves, or leave it blank to use your default Grove.",
  // Phase F residency round-trip refusals (`host/membership-error.ts`). Same
  // doctrine: user-outcome sentences, no CLI verbs, no mechanism nouns.
  residency_transition_in_flight:
    'A move is already in progress for this project — let it finish (or cancel it) first.',
  residency_requires_host_update:
    "The team host needs an update before it can accept this project's history.",
  residency_pull_unavailable:
    "This host is running an older Myco version and can't send this project's data back yet — you can disconnect without bringing it back, or update the host first.",
  residency_detach_needs_root:
    'Reconnect this project once first so Myco learns its folder, then disconnect.',
  residency_abort_too_late: RESIDENCY_ABORT_TOO_LATE_GENERIC,
  leave_projects_attached:
    'This host still has projects attached through it. Detach each project first — its row has a Detach control — then leave.',
  leave_transition_in_flight:
    'A project is still moving through this host. Wait for the move to finish, then leave.',
};

/**
 * Read-surface warning shown inline on a project ref row whose `mismatch`
 * flag is set (`HostMembershipProjectRef.mismatch === 'attach_grove_mismatch'`
 * — server-mode design spec §2(c)) — a persistent badge, not a failed-
 * mutation banner, so it is worded independently of the `attach_grove_mismatch`
 * entry above rather than reusing it verbatim: a badge needs its own concise
 * phrasing, not the fuller sentence a one-off error banner can afford
 * (copy doctrine, decision-6a2ccfac — user vocabulary only, both places).
 */
export const ATTACH_MISMATCH_WARNING_COPY =
  "This project's link to the host is out of date and needs attention — detach and re-attach it to fix the routing.";

/**
 * Leave-host confirm copy (E-4 W1 Task T5) — shared by the joined-hosts list
 * (`HostCard`) and the host detail slideout (`HostDetailPanel`) so the two
 * surfaces never drift into two different sentences for the same action.
 */
export function leaveHostConfirmMessage(hostLabel: string): string {
  // Only the no-attached-projects path can reach this confirm: the Leave
  // control disables itself while projects are attached (the server refuses
  // that leave outright), so the message never has to explain detach-first.
  return `Leave "${hostLabel}"? This removes this host's overlay connection from this machine.`;
}

/**
 * Reachability copy for the host detail slideout's live health read
 * (E-4 W1 Task T5, decision-ef693c71 D3) — `null` from the wire is "not
 * confirmable" (no proxy port on record to dial, never a false negative),
 * distinct from a probe that ran and came back `false`.
 */
export type HostReachabilityDisplayState = 'checking' | 'reachable' | 'unreachable' | 'not_confirmable';

export const HOST_REACHABILITY_COPY: Record<HostReachabilityDisplayState, string> = {
  checking: 'Checking…',
  reachable: 'Reachable',
  unreachable: 'Unreachable',
  not_confirmable: 'Not confirmed reachable',
};

/** Short reachability suffix for the attach panel's host `<select>` options —
 *  read-only against whatever the health query already has cached (never
 *  triggers its own probe). `undefined` means no cached entry for that host
 *  yet, which renders no hint at all rather than a guess. */
export function reachabilityHintSuffix(reachable: boolean | null | undefined): string {
  if (reachable === undefined) return '';
  if (reachable === null) return ' — not confirmed';
  return reachable ? ' — reachable' : ' — unreachable';
}

/**
 * Protocol-skew note (`HostProtocolSkew` from `host-membership.ts`) — user-
 * outcome voice naming WHOSE machine needs the update, never the raw
 * "protocol_skew"/version-number mechanics.
 */
export function protocolSkewNote(skew: 'none' | 'host_newer' | 'host_older'): string | null {
  switch (skew) {
    case 'host_newer':
      return "This host is running a newer Myco version — update this machine's Myco to stay in sync.";
    case 'host_older':
      return 'This host is running an older Myco version — the host needs a Myco update.';
    case 'none':
      return null;
  }
}

/** Label + helper for the attach panel's local-Grove picker (decision-
 *  ef693c71 D1) — names the MEMBER's own local Groves (permitted vocabulary;
 *  the host side of this panel never gets the word "Grove" — see the Host
 *  `<select>` and `AttachProjectPanel`'s own intro copy). */
export const LOCAL_GROVE_PICKER_LABEL = 'Show under';
export const LOCAL_GROVE_PICKER_HELPER =
  "Pick which of your own local Groves this project appears under once attached. Defaults to your default Grove.";

/** Empty-state line for the host detail slideout's attached-projects list. */
export const HOST_DETAIL_NO_PROJECTS_COPY = 'No projects attached to this host yet.';

/**
 * One-line notice replacing the backups LIST for an attached (hosted)
 * project (LOCKED decision D-W2-4, E-4 W2 Task 7 item f). `GET /api/backups`
 * is localhost-only — unlike the backup/restore MUTATIONS, which are
 * degrade-stamped and already render the uniform `HostedUnavailable` strip
 * on a 409 (`lib/degrade.ts`, `ui/components/ui/hosted-unavailable.tsx`) —
 * so it succeeds and would otherwise list the MEMBER's own local
 * display-Grove backups as if they belonged to the team project: actively
 * misleading. This keys on the attached selection directly (proactive
 * suppression, not an error response), so it is its own plain-language line
 * rather than routed through `hostedUnavailableMessage`'s generic "isn't
 * available yet" phrasing. User vocabulary, zero "grove" strings.
 */
export const BACKUPS_HOSTED_LIST_NOTICE = "This project's team storage is backed up by its host.";

function apiErrorCode(err: ApiError): string | null {
  if (typeof err.body !== 'object' || err.body === null) return null;
  const error = (err.body as { error?: { code?: unknown } }).error;
  const code = error && typeof error === 'object' ? (error as { code?: unknown }).code : null;
  return typeof code === 'string' ? code : null;
}

/** The stable membership error code carried by a failed mutation, or `null`
 *  for an uncoded / non-ApiError failure. The single place a component reads
 *  the code — flows that branch on a specific refusal (the detach
 *  `residency_pull_unavailable` fallback) key off this rather than re-deriving
 *  a check against `ApiError.body`. */
export function membershipErrorCode(err: unknown): string | null {
  return err instanceof ApiError ? apiErrorCode(err) : null;
}

/** Display copy for a failed membership mutation: mapped outcome copy for a
 *  known code, the raw message otherwise. Safe on any thrown value. */
export function membershipErrorCopy(err: unknown): string {
  const code = membershipErrorCode(err);
  if (code && MEMBERSHIP_ERROR_COPY[code]) return MEMBERSHIP_ERROR_COPY[code];
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Residency round-trip copy (Phase F, T5). Attach/detach become a data move,
// so each action sets expectations honestly BEFORE it runs, shows friendly
// progress WHILE it runs, and offers plain-language recovery. User-outcome
// vocabulary only: "moves to the team", never outbox/journal/rows — a subdued
// detail line may show a plain count.
// ---------------------------------------------------------------------------

/** Attach confirmation (D-F-1 / D-F-2). Sets the honest expectation that
 *  local history moves to the host after a local safety backup, and that
 *  earlier sessions keep only their knowledge summaries. */
export const ATTACH_CONFIRM_TITLE = 'Connect this project to the team?';
export const ATTACH_CONFIRM_COPY =
  'Connect this project to the team. If it has local history, that history moves to the team host — '
  + 'Myco saves a local backup first. Full session detail starts flowing from now on; earlier sessions '
  + 'carry their knowledge summaries.';
export const ATTACH_CONFIRM_LABEL = 'Connect to team';

/** Detach confirmation (D-F-4). */
export const DETACH_CONFIRM_TITLE = 'Disconnect this project?';
export const DETACH_CONFIRM_COPY =
  "Disconnect this project. The project's knowledge, as of this moment, comes back to this machine "
  + '(saved as a backup too); the team keeps its copy.';
export const DETACH_CONFIRM_LABEL = 'Disconnect';

/** Second-stage detach copy when the host refused with
 *  `residency_pull_unavailable` (too old to return data). The member can
 *  proceed without pulling data back (`allow_no_pull: true`). */
export const DETACH_NO_PULL_CONFIRM_COPY =
  "This host is running an older Myco version, so it can't send your data back right now. "
  + 'Disconnect anyway without bringing data back?';
export const DETACH_NO_PULL_CONFIRM_LABEL = 'Disconnect anyway';

/** Cancel-move confirmation (residency-abort). */
export const CANCEL_MOVE_CONFIRM_COPY = 'Cancel and put the project back the way it was?';

/** Direction-aware progress headline while a transition is in flight. */
export function residencyProgressHeadline(direction: ResidencyDirection | undefined): string {
  return direction === 'detach' ? 'Bringing your data back…' : 'Moving history to the team host…';
}

/** Friendly step label for a residency phase. `undefined` (phase not yet
 *  reported) renders no step, so callers should treat an empty string as
 *  "no step to show" rather than printing a placeholder. */
const RESIDENCY_PHASE_LABELS: Record<ResidencyPhase, string> = {
  parking: 'backing up',
  pushing: 'moving',
  // Retired pre-hybrid detach phases — renderable for a stale journal from an
  // older build, never produced by this version.
  pulling: 'retrieving',
  applying: 'restoring',
  fetching: 'retrieving',
  restoring: 'restoring',
  rehoming: 'finishing',
};

export function residencyPhaseLabel(phase: ResidencyPhase | undefined): string {
  return phase ? RESIDENCY_PHASE_LABELS[phase] : '';
}

/** Subdued pending-count detail, or `null` when the daemon isn't reporting a
 *  count. Plain "items", never "rows". */
export function residencyPendingDetail(rowsPending: number | null | undefined): string | null {
  if (rowsPending === null || rowsPending === undefined) return null;
  return `${rowsPending.toLocaleString()} item${rowsPending === 1 ? '' : 's'} left`;
}

/** Quiet warning shown when the transition's last attempt hit a problem. The
 *  raw `last_error` string is kept out of the visible line (surfaced only as a
 *  hover title by the caller) — this states the outcome and the way out. */
export const RESIDENCY_STALLED_COPY =
  'The last step ran into a problem and will keep retrying. Cancel the move to put the project back, then try again.';

/**
 * `residency_abort_too_late` copy for the Cancel-move control, branched on the
 * transition's direction (the progress line knows it). Attach past the point of
 * no return means the history already moved and the local rows are gone — so
 * the recovery is to disconnect, which brings the data back. Detach past the
 * point of no return means the project already switched back to local and is
 * just finishing. `undefined` falls back to a direction-agnostic line (the same
 * one the `MEMBERSHIP_ERROR_COPY` map carries for non-directional callers).
 */
export function residencyAbortTooLateCopy(direction: ResidencyDirection | undefined): string {
  switch (direction) {
    case 'attach':
      return "This move already completed — it can't be cancelled. To bring your data back, disconnect the project.";
    case 'detach':
      return 'Too late to cancel — the project is already back on this machine; let it finish.';
    default:
      return RESIDENCY_ABORT_TOO_LATE_GENERIC;
  }
}
