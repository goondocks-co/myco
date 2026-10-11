import { randomBytes } from 'node:crypto';
import { expect } from 'bun:test';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, MEMBER_ID, memberHeadersFor, type ParityScenario } from '../harness.ts';

/** A member ends only its presented credential lineage through each serving front door. */
export const credentialRevoke: ParityScenario = {
  name: 'member credential self-revocation ends its lineage on both front doors',
  async run(target) {
    const now = Date.now();
    const memberId = `mem_revoke_${randomBytes(5).toString('hex')}`;
    const machineId = `machine_revoke_${randomBytes(5).toString('hex')}`;
    const root = { id: `mt_revoke_${randomBytes(6).toString('hex')}`, token: randomBytes(32).toString('base64url') };
    const successor = { id: `mt_revoke_${randomBytes(6).toString('hex')}`, token: randomBytes(32).toString('base64url') };
    const other = { id: `mt_revoke_${randomBytes(6).toString('hex')}`, token: randomBytes(32).toString('base64url') };
    const expires = now + 3_600_000;
    const unseen = `proj_revoke_${randomBytes(5).toString('hex')}`;
    await target.sql(`INSERT INTO members(id,label,created_at,role) VALUES (${lit(memberId)},'revoke parity',${now},'member')`);
    try {
      await target.sql(`INSERT INTO machine_claims(machine_id,member_id,claimed_at) VALUES (${lit(machineId)},${lit(memberId)},${now})`);
      const insert = async (credential: typeof root, owner: string, machine: string, predecessor: string | null, lineageRoot: string) =>
        target.sql(`INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,bytes_written,predecessor_id,lineage_root,lineage_started_at)
          VALUES (${lit(credential.id)},${lit(owner)},${lit(machine)},${lit(await sha256Hex(credential.token))},${now},${expires},0,${predecessor === null ? 'NULL' : lit(predecessor)},${lit(lineageRoot)},${now})`);
      await insert(root, memberId, machineId, null, root.id);
      await insert(successor, memberId, machineId, root.id, root.id);
      await insert(other, MEMBER_ID, 'machine_parity', null, other.id);
      const { [PROJECT_HEADER]: _project, ...unbound } = memberHeadersFor(root.token, target.projectId);
      const post = (token: string, body = '{}', project?: string) => fetch(`${target.url}/members/credential/revoke`, {
        method: 'POST', headers: { ...unbound, authorization: `Bearer ${token}`, ...(project ? { [PROJECT_HEADER]: project } : {}), 'content-type': 'application/json' }, body,
      });
      const rows = async () => (await target.sql(`SELECT id,revoked_at,revoked_by FROM member_credentials WHERE id IN (${lit(root.id)},${lit(successor.id)},${lit(other.id)})`))
        .map((row) => ({ id: row.id, revokedAt: row.revoked_at, revokedBy: row.revoked_by }));

      const denied = await (await post(root.token, '{"tokenId":"' + other.id + '"}')).json() as Record<string, unknown>;
      expect(denied).toEqual({ persisted: false, code: 'unknown_field', reason: 'unknown field tokenId' });
      expect((await rows()).every((row) => row.revokedAt === null)).toBe(true);
      const result = await post(root.token, '{}', unseen);
      expect({ status: result.status, protocol: result.headers.get(PROTOCOL_HEADER), body: await result.json() })
        .toEqual({ status: 200, protocol: String(SERVER_PROTOCOL), body: { persisted: true, revoked: 2 } });
      expect(Object.fromEntries((await rows()).map((row) => [row.id, { revokedAt: row.revokedAt, revokedBy: row.revokedBy }])))
        .toEqual({
          [root.id]: { revokedAt: expect.any(Number), revokedBy: memberId },
          [successor.id]: { revokedAt: expect.any(Number), revokedBy: memberId },
          [other.id]: { revokedAt: null, revokedBy: null },
        });
      expect((await post(root.token)).status).toBe(401);
      expect((await post(successor.token)).status).toBe(401);
      const otherRead = await fetch(`${target.url}/members/status`, { method: 'POST',
        headers: { ...unbound, authorization: `Bearer ${other.token}`, 'content-type': 'application/json' }, body: '{}' });
      expect(otherRead.status).toBe(200);
      expect(await target.sql(`SELECT COUNT(*) AS n FROM projects WHERE project_id = ${lit(unseen)}`)).toEqual([{ n: 0 }]);
    } finally {
      await target.sql(`DELETE FROM member_credentials WHERE id IN (${lit(root.id)},${lit(successor.id)},${lit(other.id)})`);
      await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(machineId)}`);
      await target.sql(`DELETE FROM members WHERE id = ${lit(memberId)}`);
    }
  },
};
