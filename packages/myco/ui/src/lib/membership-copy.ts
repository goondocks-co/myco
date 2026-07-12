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
  host_predates_served_grove:
    "This host hasn't reported which Grove it serves yet — update Myco on the host machine, then re-join and try attaching again.",
  attach_grove_mismatch:
    "This project's attach record points at a Grove the host no longer serves. Detach and re-attach to route it to the host's current Grove.",
};

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
