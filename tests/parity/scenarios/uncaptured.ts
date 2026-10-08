import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { lit, MACHINE_ID, MEMBER_ID, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * Repositories a machine joins by itself, or cannot (#1547), on both targets: a repository joins the project created
 * for it, and every clone of it the same project; one a machine cannot capture is listed on the dashboard to its own
 * member and to an administrator, and never to another member, who can neither read nor connect it.
 */
export const uncaptured: ParityScenario = {
  name: 'auto-join: a repository joins one project for every clone, and a member reads and connects only their own',
  async run(target: ParityTarget) {
    const now = Date.now();
    const remote = `https://github.com/parity/auto-join-${now}`;
    const keyOf = (n: number) => `${now.toString(16)}${n}`.padEnd(16, '0').slice(0, 16);
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const machine = async (headers: Record<string, string>, path: string, body: unknown) => {
      const res = await fetch(`${target.url}${path}`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(res.status).toBe(200);
      return res.json() as Promise<Record<string, any>>;
    };
    const otherMachine = `m_parity_uncaptured_${now}`;
    let otherMember: string | null = null;
    let created: string | null = null;
    const claimed = (await target.sql(`SELECT COUNT(*) AS n FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`))[0]!.n === 0;
    if (claimed) await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(MACHINE_ID)}, ${lit(MEMBER_ID)}, ${now})`);
    try {
      // A new repository joins a project created for it, and a second clone of it the same project.
      const first = await machine(target.memberHeaders(), '/members/projects/resolve', { rootKey: keyOf(1), label: `auto-join-${now}`, remote });
      expect(first).toMatchObject({ persisted: true, created: true });
      created = String(first.projectId);
      expect(await machine(target.memberHeaders(), '/members/projects/resolve', { rootKey: keyOf(2), label: 'clone', remote: `git@github.com:parity/auto-join-${now}.git` }))
        .toEqual({ persisted: true, projectId: created, name: `auto-join-${now}`, created: false });

      // Another member, whose machine reports a repository of its own.
      const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: owner, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
      const joined = await (await fetch(`${target.url}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ key: invite.key, machineId: otherMachine }),
      })).json() as { joined: boolean; memberId: string; token: string };
      expect(joined.joined).toBe(true);
      otherMember = joined.memberId;
      await target.sql(`UPDATE members SET github_id = '5150616' WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: '5150616', login: 'other', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const asOther = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
      expect(await machine(memberHeadersFor(joined.token, target.projectId), '/members/uncaptured', { rootKey: keyOf(3), label: 'theirs', reason: 'outside_folders' })).toMatchObject({ persisted: true });
      expect(await machine(target.memberHeaders(), '/members/uncaptured', { rootKey: keyOf(4), label: 'mine', reason: 'outside_folders' })).toMatchObject({ persisted: true });

      const listed = async (headers: Record<string, string>) => {
        const res = await fetch(`${target.url}/api/uncaptured`, { headers });
        expect(res.status).toBe(200);
        return ((await res.json()) as { items: Array<{ machineId: string; label: string; member: { id: string } }> }).items
          .filter((item) => item.machineId === otherMachine || item.machineId === MACHINE_ID).map((item) => item.label).sort();
      };
      // The other member reads their own machine's repository alone; an administrator reads both.
      expect(await listed(asOther)).toEqual(['theirs']);
      expect(await listed(owner)).toEqual(['mine', 'theirs']);

      // The other member cannot connect this machine's repository, and can connect their own.
      const connect = (headers: Record<string, string>, machineId: string, rootKey: string) =>
        fetch(`${target.url}/api/uncaptured/${machineId}/${rootKey}/connect`, { method: 'POST', headers, body: '{}' });
      expect((await connect(asOther, MACHINE_ID, keyOf(4))).status).toBe(404);
      expect((await connect(asOther, otherMachine, keyOf(3))).status).toBe(200);
    } finally {
      await target.sql(`DELETE FROM uncaptured_roots WHERE machine_id IN (${lit(MACHINE_ID)}, ${lit(otherMachine)})`);
      await target.sql(`DELETE FROM machine_settings WHERE machine_id IN (${lit(MACHINE_ID)}, ${lit(otherMachine)})`);
      await target.sql(`DELETE FROM project_remotes WHERE remote = ${lit(`github.com/parity/auto-join-${now}`)}`);
      if (created !== null) await target.sql(`UPDATE projects SET archived_at = ${Date.now()} WHERE project_id = ${lit(created)}`);
      if (claimed) await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`);
      if (otherMember !== null) {
        await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(otherMember)} AND revoked_at IS NULL`);
        await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(otherMember)}`);
      }
    }
  },
};
