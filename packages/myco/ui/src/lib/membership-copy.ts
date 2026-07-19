import { ApiError } from './api';

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
export function leaveHostConfirmMessage(hostLabel: string, attachedProjectCount: number): string {
  return attachedProjectCount > 0
    ? `Leave "${hostLabel}"? This detaches ${attachedProjectCount} attached project${attachedProjectCount === 1 ? '' : 's'} `
      + '(they go back to local-only) and removes this host\'s overlay connection.'
    : `Leave "${hostLabel}"? This removes this host's overlay connection from this machine.`;
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

/** Display copy for a failed membership mutation: mapped outcome copy for a
 *  known code, the raw message otherwise. Safe on any thrown value. */
export function membershipErrorCopy(err: unknown): string {
  if (err instanceof ApiError) {
    const code = apiErrorCode(err);
    if (code && MEMBERSHIP_ERROR_COPY[code]) return MEMBERSHIP_ERROR_COPY[code];
  }
  return err instanceof Error ? err.message : String(err);
}
