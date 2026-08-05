/**
 * Issue a real per-member token for a test that needs to reach the team
 * listener.
 *
 * The shared host bearer is no longer accepted — that removal is the point of
 * per-member tokens, since every member holds a copy of the shared one and
 * leaving it valid would make revocation decorative. So a fixture can no longer
 * invent a bearer string; it has to hold a credential the host actually issued.
 *
 * This writes through the REAL store (`team-host/member-tokens.ts`), so a suite
 * using it exercises the same validation path production does, including the
 * per-request disk read that makes revocation immediate. It resolves under
 * `MYCO_TEAM_HOME`, so call it AFTER the suite has pointed that at its tmpdir.
 */
import { issueMemberToken } from '@myco/team-host/member-tokens';

/** A machine id shaped like the real thing (`{gh_user}_{8 hex}`). */
export const TEST_MEMBER_MACHINE_ID = 'tester_0a1b2c3d';

/** Issue a token and return the raw value, as a member would hold it. */
export function issueTestMemberToken(machineId: string = TEST_MEMBER_MACHINE_ID): string {
  return issueMemberToken(machineId).token;
}
