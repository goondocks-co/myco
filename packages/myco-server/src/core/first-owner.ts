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
import { ensureMemberStatement } from '../auth/enrollment.js';
import { identityLinkStatements } from '../auth/identity-link.js';
import { MEMBER_ID_PREFIX, SERVER_SCHEMA_VERSION } from '../constants.js';
import { FIRST_MEMBER_KEY, FIRST_OWNER_MEMBER_LABEL } from './ownership.js';
export { FIRST_MEMBER_KEY } from './ownership.js';

/** A first-owner setup the Deployment's state refuses, in words its operator acts on. */
export class FirstOwnerRefused extends Error {}

export const FIRST_OWNER_HAS_MEMBERS = 'this Deployment already has members; use its existing administrator and invitation flow';
export const FIRST_OWNER_LINKED = 'this Deployment already has a linked administrator; use its existing administrator and invitation flow';

export interface FirstOwnerLink {
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
  const version = await db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").first<{ value: string }>();
  if (Number(version?.value) !== SERVER_SCHEMA_VERSION) throw new FirstOwnerRefused(schemaMismatch);
  let receipt = await receiptOf(db);
  const { results: members } = await db.prepare('SELECT id, role, github_id, revoked_at FROM members LIMIT 2')
    .all<{ id: string; role: string; github_id: string | null; revoked_at: number | null }>();
  // An earlier setup's own admin, unlinked and live, or its receipt with the member not yet written, is taken again.
  const pending = receipt !== null && (members.length === 0
    || (members.length === 1 && members[0].id === receipt && members[0].role === 'admin' && members[0].github_id === null && members[0].revoked_at === null));
  if (!pending && (members.length !== 0 || receipt !== null)) throw new FirstOwnerRefused(FIRST_OWNER_HAS_MEMBERS);
  if (receipt === null) {
    const claimed = `${MEMBER_ID_PREFIX}${crypto.randomUUID()}`;
    // The receipt is claimed only while no member exists and no other setup holds it; a setup that loses the race stops.
    const took = await db.prepare(`INSERT INTO schema_meta (key, value) SELECT ?, ?
                                     WHERE NOT EXISTS (SELECT 1 FROM members) AND NOT EXISTS (SELECT 1 FROM schema_meta WHERE key = ?)`)
      .bind(FIRST_MEMBER_KEY, claimed, FIRST_MEMBER_KEY).run();
    // A claim whose answer went missing is sent again and changes nothing the second time; the receipt then names it.
    if (took.meta.changes !== 1 && (await receiptOf(db)) !== claimed) throw new FirstOwnerRefused(FIRST_OWNER_HAS_MEMBERS);
    receipt = claimed;
  }
  const memberId = receipt;
  await ensureMemberStatement(db, memberId, nowMs, 'admin', { sql: '(SELECT value FROM schema_meta WHERE key = ?) = ?', params: [FIRST_MEMBER_KEY, memberId] }, FIRST_OWNER_MEMBER_LABEL).run();
  const issue = await identityLinkStatements(db, memberId, nowMs, { replaceUnspent: true });
  const [insert, ...rest] = issue.statements;
  if ((await insert.run()).meta.changes !== 1) throw new FirstOwnerRefused(FIRST_OWNER_LINKED);
  for (const statement of rest) await statement.run();
  return { memberId, key: issue.key, expiresAt: issue.expiresAt };
}

/** The member id the first-owner receipt names, or null where no setup claimed one. */
async function receiptOf(db: RelationalStore): Promise<string | null> {
  return (await db.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(FIRST_MEMBER_KEY).first<{ value: string }>())?.value ?? null;
}
