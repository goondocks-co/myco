import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { lit, MACHINE_ID, MEMBER_ID, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

type Machine = { machineId: string; name: string | null; live: boolean; member: { id: string }; credentialCount: number; liveCredentialCount: number; bytesWritten: number };

/**
 * The machines on the People & machines page, on both targets: named by the host a join sends, read whole by an admin
 * and a member's own by a member, renamed by an admin or the machine's own member in one write to the machine, and a
 * member's Status showing only their own machines' capture.
 */
export const machines: ParityScenario = {
  name: 'machines: named at join, read by whose they are, renamed on the machine',
  async run(target: ParityTarget) {
    const now = Date.now();
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const otherMachine = `m_parity_machines_${now}`;
    let otherMember: string | null = null;
    // The parity member's machine, claimed as a join claims it, for as long as this scenario runs.
    const claimed = (await target.sql(`SELECT COUNT(*) AS n FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`))[0]!.n === 0;
    if (claimed) await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(MACHINE_ID)}, ${lit(MEMBER_ID)}, ${now})`);
    try {
      const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: owner, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
      const joined = await (await fetch(`${target.url}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
        body: JSON.stringify({ key: invite.key, machineId: otherMachine, runtimeLabel: 'parity-host', runtimeKind: 'persistent' }),
      })).json() as { joined: boolean; memberId: string };
      expect(joined.joined).toBe(true);
      otherMember = joined.memberId;
      await target.sql(`UPDATE members SET github_id = '5150616' WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: '5150616', login: 'other', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const asOther = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
      const list = async (headers: Record<string, string>) => {
        const res = await fetch(`${target.url}/api/machines`, { headers });
        expect(res.status).toBe(200);
        return ((await res.json()) as { machines: Machine[] }).machines;
      };
      const rename = (headers: Record<string, string>, machineId: string, label: unknown) =>
        fetch(`${target.url}/api/machines/${machineId}`, { method: 'PATCH', headers, body: JSON.stringify({ label }) });

      // The admin reads every machine, the joined one named after the host it sent.
      expect((await list(owner)).find((m) => m.machineId === otherMachine)).toMatchObject({ name: 'parity-host', live: true, member: { id: joined.memberId } });
      // The member reads their own machine alone.
      expect((await list(asOther)).map((m) => m.machineId)).toEqual([otherMachine]);

      // The member renames their own machine, and not another member's.
      expect(await (await rename(asOther, otherMachine, 'Parity laptop')).json() as unknown).toEqual({ machineId: otherMachine, name: 'Parity laptop' });
      // Another member's machine answers as an unknown one does.
      expect((await rename(asOther, MACHINE_ID, 'taken')).status).toBe(404);
      // An admin renames any machine, in one write to the machine and none to its credentials.
      expect((await rename(owner, otherMachine, 'Renamed by admin')).status).toBe(200);
      expect(await target.sql(`SELECT label FROM machine_claims WHERE machine_id = ${lit(otherMachine)}`)).toEqual([{ label: 'Renamed by admin' }]);
      expect(await target.sql(`SELECT DISTINCT runtime_label AS label FROM member_credentials WHERE machine_id = ${lit(otherMachine)}`)).toEqual([{ label: 'parity-host' }]);
      expect((await list(asOther))[0]!.name).toBe('Renamed by admin');
      expect((await rename(owner, otherMachine, 'two\nlines')).status).toBe(400);
      expect((await rename(owner, 'm_nobody_claims', 'x')).status).toBe(404);

      // A member's Status carries their own machines' capture, and no other machine's.
      const status = await (await fetch(`${target.url}/api/status`, { headers: asOther })).json() as { capture: Array<{ machineId: string }> };
      expect(status.capture.filter((row) => row.machineId !== otherMachine)).toEqual([]);

      await machineHistory(target, otherMachine, joined.memberId, asOther);

      // A machine with no live credential still takes a name.
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE machine_id = ${lit(otherMachine)} AND revoked_at IS NULL`);
      expect((await rename(owner, otherMachine, 'late')).status).toBe(200);
      expect((await list(owner)).find((m) => m.machineId === otherMachine)).toMatchObject({ name: 'late', live: false });
    } finally {
      if (claimed) await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`);
      if (otherMember !== null) {
        await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(otherMember)} AND revoked_at IS NULL`);
        await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(otherMember)}`);
      }
    }
  },
};

/** A large credential history still has one summary and one merged event page on each target's own store. */
async function machineHistory(target: ParityTarget, machineId: string, memberId: string, asMember: Record<string, string>) {
  const now = Date.now();
  const credentialPrefix = `mt_parity_machine_${now}_`;
  const eventPrefix = `ev_parity_machine_${now}_`;
  const session = `session_parity_machine_${now}`;
  const secondProject = `proj_${now.toString(16).padStart(32, '0')}`;
  const token = (i: number) => `${credentialPrefix}${String(i).padStart(4, '0')}`;
  const event = (i: number) => `${eventPrefix}${String(i).padStart(4, '0')}`;
  const primary = target.projectId;
  const expected = Array.from({ length: 500 }, (_, index) => {
    const i = index + 1;
    return { eventId: event(i), projectId: i % 2 === 0 ? secondProject : primary, createdAt: now - Math.floor((i - 1) / 3) };
  }).sort((a, b) => b.createdAt - a.createdAt || b.projectId.localeCompare(a.projectId) || b.eventId.localeCompare(a.eventId));
  const activityPath = `/api/machines/${machineId}/activity`;
  const read = async <T,>(path: string, headers = asMember): Promise<T> => {
    const response = await fetch(`${target.url}${path}`, { headers });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  try {
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<5000)
      INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, revoked_at, revoked_by, bytes_written, lineage_root, lineage_started_at)
      SELECT ${lit(credentialPrefix)} || printf('%04d',i), ${lit(memberId)}, ${lit(machineId)},
        ${lit(`hash_${credentialPrefix}`)} || printf('%04d',i), ${now - 1_000_000} + i, ${now - 1}, ${now - 1}, ${lit(memberId)}, 1,
        ${lit(credentialPrefix)} || printf('%04d',i), ${now - 1_000_000} + i FROM n`);
    const summary = await read<{ machines: Machine[]; cursor: string | null }>('/api/machines?limit=50');
    expect(summary.machines).toHaveLength(1);
    expect(summary.cursor).toBeNull();
    expect(summary.machines[0]).toMatchObject({
      machineId, name: 'Renamed by admin', live: true, member: { id: memberId },
      credentialCount: 5_001, liveCredentialCount: 1, bytesWritten: 5_000,
    });

    await target.sql(`INSERT INTO projects (project_id, name, created_at) VALUES (${lit(secondProject)}, 'Machine activity parity', ${now})`);
    await target.sql(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
      VALUES (${lit(primary)}, ${lit(session)}, ${lit(machineId)}, ${lit(token(1))}, ${now - 500}, ${now}),
             (${lit(secondProject)}, ${lit(session)}, ${lit(machineId)}, ${lit(token(2))}, ${now - 500}, ${now})`);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<500)
      INSERT INTO events (project_id, event_id, session_id, token_id, kind, channel, payload, envelope_hash, created_at, received_at)
      SELECT CASE WHEN i % 2 = 0 THEN ${lit(secondProject)} ELSE ${lit(primary)} END,
        ${lit(eventPrefix)} || printf('%04d',i), ${lit(session)}, ${lit(credentialPrefix)} || printf('%04d',i),
        'prompt', 'capture', '{}', ${lit(`hash_${eventPrefix}`)} || printf('%04d',i),
        ${now} - CAST((i - 1) / 3 AS INTEGER), ${now} - CAST((i - 1) / 3 AS INTEGER) FROM n`);

    const first = await read<{ rows: typeof expected; cursor: string | null }>(`${activityPath}?limit=50`);
    expect(first.rows).toHaveLength(50);
    expect(first.rows.map(({ eventId, projectId, createdAt }) => ({ eventId, projectId, createdAt }))).toEqual(expected.slice(0, 50));
    expect(first.cursor).not.toBeNull();
    const second = await read<{ rows: typeof expected; cursor: string | null }>(`${activityPath}?limit=50&cursor=${encodeURIComponent(first.cursor!)}`);
    expect(second.rows.map(({ eventId, projectId, createdAt }) => ({ eventId, projectId, createdAt }))).toEqual(expected.slice(50, 100));

    const hidden = await fetch(`${target.url}/api/machines/${MACHINE_ID}/activity?limit=50`, { headers: asMember });
    const absent = await fetch(`${target.url}/api/machines/machine_that_does_not_exist/activity?limit=50`, { headers: asMember });
    expect({ status: hidden.status, body: await hidden.json() }).toEqual({ status: absent.status, body: await absent.json() });
    expect(hidden.status).toBe(404);
  } finally {
    await target.sql(`DELETE FROM events WHERE event_id LIKE ${lit(`${eventPrefix}%`)}`);
    await target.sql(`DELETE FROM sessions WHERE session_id = ${lit(session)} AND project_id IN (${lit(primary)}, ${lit(secondProject)})`);
    await target.sql(`DELETE FROM member_credentials WHERE id LIKE ${lit(`${credentialPrefix}%`)}`);
    await target.sql(`DELETE FROM projects WHERE project_id = ${lit(secondProject)}`);
  }
}
