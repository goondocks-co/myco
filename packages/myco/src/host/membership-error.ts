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
  | 'protocol_mismatch';

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
