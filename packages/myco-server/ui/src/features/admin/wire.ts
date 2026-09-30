/**
 * The shapes the admin pages read of members, invitations, machines'
 * credentials and access keys, as the server sends them.
 *
 * The dashboard cannot import the server's declarations (their modules carry
 * runtime imports its build does not), so they are declared here, with no
 * imports, and `tests/myco-server/admin-wire.test.ts` holds each to the
 * server's own under `typecheck:tests`.
 */

/** `GET /api/members`: one member of the Deployment. */
export interface MemberRow {
  id: string;
  label: string | null;
  /** What this member may do. A worker's credential must belong to an admin, which is what makes a claim from it admissible. */
  role: 'admin' | 'member';
  /** Whether a GitHub account is connected. */
  linked: boolean;
  createdAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  /** How many of this member's own runtimes authenticate now. */
  liveCredentials: number;
  /**
   * The account Myco's own work signs in as, which is no person. The server
   * marks it once it sends the flag; until then the admin pages know it by its
   * id (`isSystemMember`).
   */
  system?: boolean;
}

export interface MembersAnswer {
  members: MemberRow[];
}

/** `GET /api/enrollment`: an invitation that can still be redeemed. */
export interface InvitationRow {
  id: string;
  /** The member the invitation adds a machine to, or null for a new member. */
  memberId: string | null;
  createdBy: string | null;
  createdAt: number;
  expiresAt: number;
  role: 'admin' | 'member';
}

export interface InvitationsAnswer {
  invitations: InvitationRow[];
}

/** `POST /api/enrollment`: the new invitation's key, answered once. */
export interface MintedInvitation {
  key: string;
  id: string;
  expiresAt: number;
}

/** `GET /api/credentials`: one credential, a member's runtime on a machine or one agent run's. */
export interface CredentialRow {
  id: string;
  memberId: string;
  machineId: string | null;
  /** The name the runtime gave itself when it joined, or null when it gave none. */
  runtimeLabel: string | null;
  expiresAt: number;
  revokedAt: number | null;
  revokedBy: string | null;
  bytesWritten: number;
  /** The first credential of this one's line of refreshes. */
  lineageRoot: string;
  lineageStartedAt: number;
  firstUsedAt: number | null;
  /** Whether this credential authenticates now: unrevoked, unexpired, and its member live. Not a statement that it has written anything. */
  live: boolean;
  /** What the server minted this credential for: one agent run, or a member's own runtime. */
  purpose: 'run' | 'member';
}

export interface CredentialPage {
  rows: readonly CredentialRow[];
  cursor: string | null;
}

/** `GET /api/credentials/{id}/activity`: one event a credential wrote. */
export interface ActivityRow {
  eventId: string;
  projectId: string;
  sessionId: string;
  kind: string;
  createdAt: number;
  receivedAt: number;
}

export interface ActivityPage {
  rows: readonly ActivityRow[];
  cursor: string | null;
}

/** `GET /api/projects/{p}/grants`: an access key an external agent reads one project with. */
export interface GrantRow {
  id: string;
  projectId: string;
  label: string | null;
  createdBy: string;
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  rotatedTo: string | null;
}

export interface GrantsAnswer {
  grants: GrantRow[];
}
