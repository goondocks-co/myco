import { expect } from 'bun:test';
import { jsonBody } from '../../helpers/json-body.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { LINK_REQUIRES_ADMIN } from '@myco-server-worker/auth/members.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { GITHUB_SUB, MEMBER_ID, SESSION_SECRET, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const OTHER = 'mem_parity_link';
const OTHER_SUB = '515151';

/**
 * Bootstrap, then admin (#1448), on both targets: a member credential links
 * its own GitHub account only while no admin is linked, so the first sign-in
 * on a fresh Deployment binds and every later self-link is refused
 * `link_requires_admin` with no key written; a signed-in admin creates a link
 * for a member from the dashboard, which a member bearer cannot, and the
 * account that confirms it signs in.
 */
export const githubLink: ParityScenario = {
  name: 'github link: the first sign-in links itself, then only a signed-in admin links a member',
  async run(target) {
    const now = Date.now();
    const otherToken = `github-link-parity-${now}`.padEnd(43, 'x');
    const otherTokenId = `mt_github_link_${now}`;
    await target.sql(`INSERT INTO members (id, label, created_at, role) VALUES (${lit(OTHER)}, 'parity link', ${now}, 'admin')`);
    await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
      VALUES (${lit(otherTokenId)}, ${lit(OTHER)}, 'machine_parity_link', ${lit(await sha256Hex(otherToken))}, ${now}, ${now + 3_600_000}, 0, ${lit(otherTokenId)}, ${now})`);
    try {
      const selfLink = (token: string) => fetch(`${target.url}/members/link-github`, {
        method: 'POST', headers: { ...target.memberHeaders({ authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, body: '{}',
      });
      const confirm = async (sub: string, body: Record<string, unknown>) => fetch(`${target.url}/auth/link`, {
        method: 'POST', headers: await sessionHeaders(target, sub), body: JSON.stringify(body),
      });
      const linkKeys = async () => Number((await target.sql(`SELECT COUNT(*) AS n FROM identity_link_authorities WHERE member_id IN (${lit(MEMBER_ID)}, ${lit(OTHER)})`))[0]?.n);
      const refusedBody = { persisted: false, code: 'link_requires_admin', reason: LINK_REQUIRES_ADMIN };

      // The Deployment's admin is linked: every member credential's self-link is refused, an unlinked admin's included.
      expect(await jsonBody(await selfLink(otherToken))).toEqual(refusedBody);
      expect(await jsonBody(await selfLink(target.memberToken))).toEqual(refusedBody);
      expect(await linkKeys()).toBe(0);

      // A fresh Deployment: the first self-link binds, and that account signs in.
      await target.sql(`UPDATE members SET github_id = NULL WHERE id = ${lit(MEMBER_ID)}`);
      try {
        const minted = (await (await selfLink(target.memberToken)).json()) as { persisted: boolean; key: string };
        expect(minted.persisted).toBe(true);
        const bound = await confirm(GITHUB_SUB, { key: minted.key, confirm: true });
        expect({ status: bound.status, member: ((await bound.json()) as { member: { id: string } }).member.id }).toEqual({ status: 200, member: MEMBER_ID });
      } finally {
        await target.sql(`UPDATE members SET github_id = ${lit(GITHUB_SUB)} WHERE id = ${lit(MEMBER_ID)}`);
      }
      expect((await fetch(`${target.url}/api/projects`, { headers: await sessionHeaders(target, GITHUB_SUB) })).status).toBe(200);

      // Bootstrap is over.
      expect(await jsonBody(await selfLink(otherToken))).toEqual(refusedBody);

      // The admin path: owner session only; the member's own sign-in proves the account.
      const path = `${target.url}/api/members/${OTHER}/link-github`;
      const bearer = await fetch(path, { method: 'POST', headers: { ...target.memberHeaders(), origin: target.url } });
      expect(bearer.status).toBe(401);
      const created = await fetch(path, { method: 'POST', headers: await sessionHeaders(target, GITHUB_SUB) });
      expect(created.status).toBe(201);
      const { key } = (await created.json()) as { key: string };
      expect(await target.sql(`SELECT issued_by FROM identity_link_authorities WHERE member_id = ${lit(OTHER)} AND used_at IS NULL AND revoked_at IS NULL`)).toEqual([{ issued_by: MEMBER_ID }]);
      expect(await jsonBody(await confirm(OTHER_SUB, { key }))).toEqual({ preview: { member: { id: OTHER, label: 'parity link', role: 'admin' } } });
      expect((await confirm(OTHER_SUB, { key, confirm: true })).status).toBe(200);
      const me = await fetch(`${target.url}/auth/me`, { headers: await sessionHeaders(target, OTHER_SUB) });
      expect(((await me.json()) as { member: { id: string } | null }).member?.id).toBe(OTHER);
    } finally {
      await target.sql(`DELETE FROM identity_link_authorities WHERE member_id IN (${lit(MEMBER_ID)}, ${lit(OTHER)})`);
      await target.sql(`DELETE FROM member_credentials WHERE id = ${lit(otherTokenId)}`);
      await target.sql(`DELETE FROM members WHERE id = ${lit(OTHER)}`);
      await target.sql(`UPDATE members SET github_id = ${lit(GITHUB_SUB)} WHERE id = ${lit(MEMBER_ID)}`);
    }
  },
};

/** A same-origin dashboard request signed in as the GitHub account `sub`; the source header is load-bearing only on Cloudflare. */
async function sessionHeaders(target: ParityTarget, sub: string): Promise<Record<string, string>> {
  const session = await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login: 'parity', iat: Date.now(), exp: Date.now() + 3_600_000 });
  return { cookie: `${SESSION_COOKIE}=${session}`, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
}
