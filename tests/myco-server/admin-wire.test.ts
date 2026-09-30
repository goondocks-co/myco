/**
 * The admin pages' shared wire shapes, as the dashboard declares them, match the server's.
 *
 * `features/admin/wire.ts` declares what People & machines, My machines and a
 * project's access keys read of members, invitations, credentials and grants;
 * this file holds each to the server's own declaration. The assertions are
 * types: `npm run typecheck:tests` fails when a shape drifts, and the one
 * runtime expectation keeps the file a test Bun collects.
 */
import { describe, expect, it } from 'bun:test';
import type * as Ui from '../../packages/myco-server/ui/src/features/admin/wire.ts';
import type { MemberRow } from '../../packages/myco-server/src/auth/members-admin.ts';
import type { InvitationRow } from '../../packages/myco-server/src/auth/enrollment.ts';
import type { GrantRow } from '../../packages/myco-server/src/auth/grants.ts';
import type { ActivityRow, CredentialRow, credentialActivity, listCredentials } from '../../packages/myco-server/src/read/credentials.ts';

/** True only when each type is assignable to the other. */
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** True when what the server sends carries every field the dashboard reads, typed as it reads it. */
type Reads<Server, Dashboard> = [Server] extends [Dashboard] ? true : false;

/** `GET /api/credentials`: the page `handleCredentials` sends. */
type CredentialsAnswer = Awaited<ReturnType<typeof listCredentials>>;
/** `GET /api/credentials/{id}/activity`: the page `handleCredentialActivity` sends. */
type ActivityAnswer = Awaited<ReturnType<typeof credentialActivity>>;
/** `POST /api/enrollment`: the body `handleMintInvitation` answers. */
type MintAnswer = { key: string; id: string; expiresAt: number; role: 'admin' | 'member'; projectId: string | null };

const SAME: [
  Same<Ui.GrantRow, GrantRow>,
  Same<Ui.ActivityRow, ActivityRow>,
] = [true, true];

const READS: [
  Reads<MemberRow, Ui.MemberRow>,
  Reads<{ members: MemberRow[] }, Ui.MembersAnswer>,
  Reads<InvitationRow, Ui.InvitationRow>,
  Reads<{ invitations: InvitationRow[] }, Ui.InvitationsAnswer>,
  Reads<MintAnswer, Ui.MintedInvitation>,
  Reads<CredentialRow, Ui.CredentialRow>,
  Reads<CredentialsAnswer, Ui.CredentialPage>,
  Reads<ActivityAnswer, Ui.ActivityPage>,
  Reads<{ grants: GrantRow[] }, Ui.GrantsAnswer>,
] = [true, true, true, true, true, true, true, true, true];

describe("the admin pages' shared wire shapes", () => {
  it('are held to the server declarations by the tests typecheck', () => {
    expect([...SAME, ...READS].every(Boolean)).toBe(true);
  });
});
