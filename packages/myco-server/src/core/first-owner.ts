/**
 * A Deployment's first administrator, on every target (#1500).
 *
 * A fresh Deployment has no member, and GitHub sign-in alone never makes one. Its operator sets up the first
 * administrator: this records an admin member and mints the private link its first GitHub sign-in confirms
 * (`auth/identity-link.ts`), the same "bootstrap, then admin" link every later admin issues, with no issuer. The local
 * target runs it over its own volume under an exclusive lease; the hosted target runs it over its database from the
 * operator's machine. Both run these statements one at a time, so each carries its own guard and none depends on a
 * batch: the receipt names the member this setup made, the member is written only while the receipt names it, and the
 * link is minted only while no administrator has a linked account.
 */
import type { RelationalStore } from './adapters.js';
import { identityLinkWrites } from '../auth/identity-link.js';
import { firstOwnerClaim, firstOwnerMemberWrite, writeAlone } from '../db/identity/enrollment.js';
import { firstOwnerMembers, firstOwnerReceipt, firstOwnerSchemaVersion } from '../db/identity/first-owner.js';
import { MEMBER_ID_PREFIX, SERVER_SCHEMA_VERSION } from '../constants.js';
import { FIRST_MEMBER_KEY, FIRST_OWNER_MEMBER_LABEL } from './ownership.js';

/** A first-owner setup the Deployment's state refuses, in words its operator acts on. */
class FirstOwnerRefused extends Error {}

export const FIRST_OWNER_HAS_MEMBERS = 'this Deployment already has members; use its existing administrator and invitation flow';
export const FIRST_OWNER_LINKED = 'this Deployment already has a linked administrator; use its existing administrator and invitation flow';

interface FirstOwnerLink {
  memberId: string;
  /** The raw key; the Deployment holds only its digest. */
  key: string;
  expiresAt: number;
}

/**
 * Record the first administrator, or take the one an earlier setup recorded and left unlinked, and mint its link,
 * replacing any unspent one. Refuses a Deployment at another schema than this build's, one with any other member, and
 * one whose administrator already linked an account.
 */
export async function setupFirstOwner(db: RelationalStore, nowMs: number, schemaMismatch: string): Promise<FirstOwnerLink> {
  const version = await firstOwnerSchemaVersion(db);
  if (Number(version) !== SERVER_SCHEMA_VERSION) throw new FirstOwnerRefused(schemaMismatch);
  let receipt = await firstOwnerReceipt(db, FIRST_MEMBER_KEY);
  const members = await firstOwnerMembers(db);
  // An earlier setup's own admin, unlinked and live, or its receipt with the member not yet written, is taken again.
  const pending = receipt !== null && (members.length === 0
    || (members.length === 1 && members[0].id === receipt && members[0].role === 'admin' && members[0].github_id === null && members[0].revoked_at === null));
  if (!pending && (members.length !== 0 || receipt !== null)) throw new FirstOwnerRefused(FIRST_OWNER_HAS_MEMBERS);
  if (receipt === null) {
    const claimed = `${MEMBER_ID_PREFIX}${crypto.randomUUID()}`;
    // The receipt is claimed only while no member exists and no other setup holds it; a setup that loses the race stops.
    const took = await writeAlone(db, firstOwnerClaim.bind(FIRST_MEMBER_KEY, claimed));
    // A claim whose answer went missing is sent again and changes nothing the second time; the receipt then names it.
    if (took === null && (await firstOwnerReceipt(db, FIRST_MEMBER_KEY)) !== claimed) throw new FirstOwnerRefused(FIRST_OWNER_HAS_MEMBERS);
    receipt = claimed;
  }
  const memberId = receipt;
  await writeAlone(db, firstOwnerMemberWrite(memberId, FIRST_OWNER_MEMBER_LABEL, nowMs, 'admin', FIRST_MEMBER_KEY));
  const issue = await identityLinkWrites(memberId, nowMs, { replaceUnspent: true });
  if (await writeAlone(db, issue.insert) === null) throw new FirstOwnerRefused(FIRST_OWNER_LINKED);
  for (const statement of issue.replace) await writeAlone(db, statement);
  return { memberId, key: issue.key, expiresAt: issue.expiresAt };
}

