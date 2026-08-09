/**
 * Stable membership-failure codes (consolidation Task D-2, review round).
 *
 * The membership orchestration (`host/attach-command.ts`,
 * `host/member-overlay.ts`) produces rich, CLI-voiced error MESSAGES ("Run
 * `myco detach` first…", "…task A2…") that are right for a terminal but must
 * not surface verbatim in the Team page — the daemon API
 * (`daemon/api/host-membership.ts`) needs a machine-readable code the UI can
 * map to its own outcome copy (`ui/src/lib/membership-copy.ts`), and message
 * sniffing at the API layer would couple the wire contract to prose.
 *
 * `attachCommand`'s error mapping deliberately converts the registry's typed
 * errors (`ProjectRegisteredLocallyError` etc.) into plain `Error`s with
 * operator-actionable messages, so an `instanceof` check is not available
 * downstream — instead the mapping stamps a `membershipCode` property on the
 * Error it builds, and the API reads it back here. Codes are only minted for
 * failures the UI renders distinct copy for; everything else falls back to
 * the route-level code (`join_failed`/`attach_failed`/…) with the raw
 * message.
 */

export type MembershipErrorCode =
  | 'project_registered_locally'
  | 'project_attached_to_other_host'
  | 'not_joined'
  | 'protocol_mismatch'
  /** The host actively refused this machine's enrollment with an auth/
   *  permission status (401/403). Surfaced by the member enrollment client
   *  (`host/member-overlay.ts`) as a coded, body-SANITIZED error — the raw
   *  host response body is NEVER carried onto the message (it can echo host
   *  internals), only the numeric status. */
  | 'host_enroll_rejected'
  /** This machine already holds a live token on that host. A decided refusal,
   *  not a transport failure: the way back in is for the operator to revoke
   *  the existing access first, so retrying re-asks a settled question. */
  | 'machine_already_enrolled'
  /** Enrollment failed for any other non-success reason: a non-2xx status
   *  other than the 409 protocol-mismatch and the 401/403 auth-rejection
   *  above, or a 200 whose body was unreadable/incomplete. Surfaced by the
   *  member enrollment client (`host/member-overlay.ts`), likewise body-
   *  sanitized (status only, never the raw response body). */
  | 'host_enroll_failed'
  /** This machine's on-disk join state for the host is corrupt or half-written
   *  — most often the residue of a pre-1.4.0 Myco that crashed mid-join (its
   *  now-retired enrollment intent no longer parses). `reserveHostEnrollment`
   *  throws `HostJoinStateCorruptError` before any network call; join maps it
   *  here so the caller learns the fix — `myco leave <host>` clears the residue
   *  — instead of seeing a raw internal message. */
  | 'host_join_state_corrupt'
  /** Attach has no Grove source: the joined host's `HostRecord` carries no
   *  `served_grove_id` because it predates served-grove designation (its
   *  enrollment response never included the field). Surfaced by
   *  `attachCommand` (`host/attach-command.ts`) — see the "update the host"
   *  copy in `mapAttachError`. */
  | 'host_predates_served_grove'
  /** An existing `AttachRef.grove_id` no longer matches the host's
   *  `served_grove_id` (server-mode design spec §2 existing-refs mitigation
   *  (c)) — surfaced read-only by the membership status probe
   *  (`GET /api/host-membership/status`), not thrown from a mutation, so a
   *  member with a stale ref sees it flagged rather than having drains fail
   *  opaquely. */
  | 'attach_grove_mismatch'
  /** An explicit `local_grove_id` passed to attach (E-4 local-view
   *  requirement) names no existing LOCAL Grove on this machine. Surfaced by
   *  `attachCommand` (`host/attach-command.ts`) before any `AttachRef` is
   *  written. Distinct Grove concept from `attach_grove_mismatch` above:
   *  that one is about the host's served (hosted) Grove, this one is about
   *  the member's own local Grove — display-only, chosen at attach time. */
  | 'unknown_local_grove'
  /** Attach or detach was refused because a residency transition (Phase F) is
   *  already in flight for this project — a journal exists under the team home.
   *  Surfaced by `attachCommand`/`detachCommand`; the running transition (or a
   *  `residency abort`) resolves it, a second start does not. */
  | 'residency_transition_in_flight'
  /** Leave was refused because projects are still attached through the host.
   *  Leaving would destroy the attach refs and the unrecoverable bearer,
   *  leaving those projects registered nowhere with capture diverting to a
   *  Grove that no longer exists locally. Detach each project, then leave. */
  | 'leave_projects_attached'
  /** Leave was refused because a residency move through this host is still in
   *  flight. Distinct from `residency_transition_in_flight` (a project-level
   *  refusal on attach/detach) because the surface is host-level and the move
   *  may be past the point where a cancel control exists — the copy must not
   *  offer one. */
  | 'leave_transition_in_flight'
  /** A with-history attach cannot proceed because the joined host predates the
   *  residency protocol (its recorded protocol version is below the minimum
   *  the row push requires). Surfaced by the residency transition — nothing has
   *  moved yet; update the host, then retry. */
  | 'residency_requires_host_update'
  /** Detach-pull cannot re-materialize the project because its attach ref has no
   *  `root` (a legacy ref recorded before `root` existed). Surfaced up-front by
   *  `detachCommand`; a re-attach backfills the root, then detach can pull. */
  | 'residency_detach_needs_root'
  /** Detach-pull is unavailable because the joined host predates the residency
   *  protocol, and the caller did not opt into a plain (no-data) detach. Surfaced
   *  by `detachCommand` — update the host, or detach without pulling. */
  | 'residency_pull_unavailable'
  /** A residency transition can no longer be aborted: an attach whose rows
   *  already moved to the host (the local copy is gone — detach is the way back),
   *  or a detach that already flipped to local (`applying`/`rehoming` — let the
   *  drain finish). Surfaced by the residency-abort route. */
  | 'residency_abort_too_late'
  /** Another operation holds this project's write lease (a move, or the other
   *  residency direction). Nothing durable has happened; retry once it ends. */
  | 'project_write_lease_held';

/** Build an Error carrying a stable membership code alongside its
 *  (CLI-voiced) message. The message still prints verbatim in terminals;
 *  the code is what survives onto the API's error envelope. */
export function codedMembershipError(code: MembershipErrorCode, message: string): Error {
  return Object.assign(new Error(message), { membershipCode: code });
}

/** Read a membership code off a thrown value, or null when it carries none. */
export function membershipErrorCode(err: unknown): MembershipErrorCode | null {
  if (!(err instanceof Error)) return null;
  const code = (err as Error & { membershipCode?: unknown }).membershipCode;
  return typeof code === 'string' ? (code as MembershipErrorCode) : null;
}
