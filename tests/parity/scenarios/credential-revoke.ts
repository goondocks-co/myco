import { expect } from 'bun:test';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { memberHeadersFor, type ParityScenario } from '../harness.ts';
import { credentials, joinMember, lapse, stopMember } from '../clients/identity.ts';
import { owner } from '../clients/requests.ts';

/** A member ends only its presented credential lineage through each serving front door. */
export const credentialRevoke: ParityScenario = {
  name: 'member credential self-revocation ends its lineage on both front doors',
  async run(target) {
    const unseen = `proj_revoke_${crypto.randomUUID().slice(0, 10)}`;
    const member = await joinMember(target);
    const unbound = (token: string) => {
      const { [PROJECT_HEADER]: _project, ...headers } = memberHeadersFor(token, target.projectId);
      return headers;
    };
    const post = (path: string, token: string, body = '{}', project?: string) => fetch(`${target.url}${path}`, {
      method: 'POST', headers: { ...unbound(token), ...(project ? { [PROJECT_HEADER]: project } : {}), 'content-type': 'application/json' }, body,
    });
    // The machine was offline past its credential's expiry and rotated once: its successor is live beside the lapsed credential.
    await lapse(target, member.tokenId);
    const rotated = await (await post('/tokens/refresh', member.token)).json() as { refreshed: boolean; token: string; tokenId: string };
    expect(rotated.refreshed).toBe(true);
    const lineage = async () => (await credentials(target)).filter((row) => row.id === member.tokenId || row.id === rotated.tokenId)
      .map(({ id, revokedAt, revokedBy }) => ({ id, revokedAt, revokedBy }));
    try {
      const denied = await (await post('/members/credential/revoke', member.token, `{"tokenId":"${member.tokenId}"}`)).json() as Record<string, unknown>;
      expect(denied).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field tokenId' });
      expect((await lineage()).every((row) => row.revokedAt === null)).toBe(true);
      const result = await post('/members/credential/revoke', member.token, '{}', unseen);
      expect({ status: result.status, protocol: result.headers.get(PROTOCOL_HEADER), body: await result.json() })
        .toEqual({ status: 200, protocol: String(SERVER_PROTOCOL), body: { persisted: true, revoked: 2 } });
      expect(Object.fromEntries((await lineage()).map(({ id, ...rest }) => [id, rest]))).toEqual({
        [member.tokenId]: { revokedAt: expect.any(Number), revokedBy: member.id },
        [rotated.tokenId]: { revokedAt: expect.any(Number), revokedBy: member.id },
      });
      expect((await post('/members/credential/revoke', member.token)).status).toBe(401);
      expect((await post('/members/credential/revoke', rotated.token)).status).toBe(401);
      expect((await post('/tokens/refresh', member.token)).status).toBe(401);
      // Another member's credential is untouched.
      expect((await post('/members/status', target.memberToken)).status).toBe(200);
      const projects = await owner(target, '/api/projects?include=archived');
      expect((projects.body.projects as Array<{ projectId: string }>).some((row) => row.projectId === unseen)).toBe(false);
    } finally {
      await stopMember(target, member.id);
    }
  },
};
