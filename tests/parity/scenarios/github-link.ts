import { expect } from 'bun:test';
import { jsonBody } from '../../helpers/json-body.js';
import { LINK_REQUIRES_ADMIN } from '@myco-server-worker/auth/members.js';
import { GITHUB_SUB, type ParityScenario } from '../harness.ts';
import { accountSession, browser, joinMember, memberView, stopMember } from '../clients/identity.ts';

/**
 * Admin linking (#1448), on both targets: once an admin is linked, a member
 * credential's self-link is refused `link_requires_admin`, the linked admin's
 * own included; a signed-in admin creates a link for a member from the
 * dashboard, which a member bearer cannot, and the account that confirms it
 * signs in. The fresh Deployment's first self-link is covered by
 * `member-sign-in.test.ts`, since every parity target boots with its admin linked.
 */
export const githubLink: ParityScenario = {
  name: 'github link: once an admin is linked a member credential cannot link itself, and only a signed-in admin links a member',
  async run(target) {
    const sub = '515151';
    const other = await joinMember(target);
    try {
      const selfLink = (token: string) => fetch(`${target.url}/members/link-github`, {
        method: 'POST', headers: { ...target.memberHeaders({ authorization: `Bearer ${token}` }), 'content-type': 'application/json' }, body: '{}',
      });
      const refusedBody = { persisted: false, code: 'link_requires_admin', reason: LINK_REQUIRES_ADMIN };

      // The Deployment's admin is linked: every member credential's self-link is refused, the admin's own included.
      expect(await jsonBody(await selfLink(other.token))).toEqual(refusedBody);
      expect(await jsonBody(await selfLink(target.memberToken))).toEqual(refusedBody);
      expect((await browser(target, '/api/projects', await accountSession(target, GITHUB_SUB))).status).toBe(200);

      // The admin path: owner session only; the member's own sign-in proves the account.
      const path = `${target.url}/api/members/${other.id}/link-github`;
      const bearer = await fetch(path, { method: 'POST', headers: { ...target.memberHeaders(), origin: target.url } });
      expect(bearer.status).toBe(401);
      const created = await browser(target, `/api/members/${other.id}/link-github`, target.ownerHeaders(), {});
      expect(created.status).toBe(201);
      const { key } = created.body as { key: string };
      const session = await accountSession(target, sub);
      const label = (await memberView(target, other.id))?.label ?? null;
      expect((await browser(target, '/auth/link', session, { key })).body).toEqual({ preview: { member: { id: other.id, label, role: 'member' } } });
      expect((await browser(target, '/auth/link', session, { key, confirm: true })).status).toBe(200);
      const me = await browser(target, '/auth/me', session);
      expect((me.body as { member: { id: string } | null }).member?.id).toBe(other.id);
    } finally {
      await stopMember(target, other.id);
    }
  },
};
