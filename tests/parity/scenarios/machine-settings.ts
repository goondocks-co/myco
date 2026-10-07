import { expect } from 'bun:test';
import fs, { mkdtempSync, rmSync } from "../../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { machinePlanDirs, seedMachineSettings, cacheMachineSettings } from '@myco/member/machine-settings.js';
import { machineSettingsPath, writeDeploymentMembership } from '@myco/member/registry.js';
import { lit, MACHINE_ID, MEMBER_ID, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

const LEAF = 'capture.plan_dirs';
/** Every other leaf a machine holds, at its default: the folders it captures repositories under, and none told to connect. */
const AT_DEFAULT = { 'capture.auto_join_roots': ['~/Repos'], 'capture.connect_roots': {} };

/**
 * A machine's settings on both targets (#1393): set on the dashboard by the machine's own member and nobody else, and
 * answered to that machine, and only that machine, at session start and on `/members/settings`, where the machine
 * caches them one file per Deployment.
 */
export const machineSettings: ParityScenario = {
  name: 'machine settings: set on the dashboard, answered to that machine alone, and cached per Deployment',
  async run(target: ParityTarget) {
    const now = Date.now();
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const put = (headers: Record<string, string>, machineId: string, value: unknown) => fetch(`${target.url}/api/machines/${machineId}/settings/${LEAF}`, {
      method: 'PUT', headers, body: JSON.stringify({ value }),
    });
    const settingsOf = async (headers: Record<string, string>) => {
      const res = await fetch(`${target.url}/members/settings`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' });
      expect(res.status).toBe(200);
      return (await res.json() as { machine?: { leaves: Record<string, unknown> } }).machine ?? null;
    };
    const otherMachine = `m_parity_settings_${now}`;
    let otherMember: string | null = null;
    const home = mkdtempSync(join(tmpdir(), 'myco-parity-machine-settings-'));
    // The parity member's machine, claimed as a join claims it, for as long as this scenario runs.
    const claimed = (await target.sql(`SELECT COUNT(*) AS n FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`))[0]!.n === 0;
    if (claimed) await target.sql(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (${lit(MACHINE_ID)}, ${lit(MEMBER_ID)}, ${now})`);
    try {
      // The parity member, who claims this machine, sets its plan folders; the machine is answered them on both of its reads.
      expect((await put(owner, MACHINE_ID, ['~/notes/plans', 'docs/plans'])).status).toBe(200);
      expect(await settingsOf(target.memberHeaders())).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['~/notes/plans', 'docs/plans'] } });
      const session = await fetch(`${target.url}/context/session`, {
        method: 'POST', headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId: `sess_parity_machine_${now}`, kind: 'start' }),
      });
      expect(((await session.json()) as { machine?: unknown }).machine).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['~/notes/plans', 'docs/plans'] } });

      // Another member's machine is answered its own settings, never this one's.
      const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: owner, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
      const joined = await (await fetch(`${target.url}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ key: invite.key, machineId: otherMachine }),
      })).json() as { joined: boolean; memberId: string; token: string };
      expect(joined.joined).toBe(true);
      otherMember = joined.memberId;
      const otherHeaders = memberHeadersFor(joined.token, target.projectId);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: [] } });

      // That member, on the dashboard, reaches its own machine and not this one.
      await target.sql(`UPDATE members SET github_id = '5150515' WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: '5150515', login: 'other', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const asOther = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
      expect((await fetch(`${target.url}/api/machines/${MACHINE_ID}/settings`, { headers: asOther })).status).toBe(403);
      expect((await put(asOther, MACHINE_ID, ['~/elsewhere'])).status).toBe(403);
      expect((await put(asOther, otherMachine, ['plans'])).status).toBe(200);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['plans'] } });

      // An admin who does not own that machine reads and writes none of it.
      expect((await fetch(`${target.url}/api/machines/${otherMachine}/settings`, { headers: owner })).status).toBe(403);
      expect((await put(owner, otherMachine, ['~/admin-was-here'])).status).toBe(403);
      expect((await put(owner, otherMachine, [])).status).toBe(403);
      expect(await settingsOf(otherHeaders)).toEqual({ leaves: { ...AT_DEFAULT, [LEAF]: ['plans'] } });

      // A folder that names the whole home, the filesystem root or the project, or climbs out, is refused.
      for (const broad of ['~', '~/', '/', '.', '../plans']) expect((await put(asOther, otherMachine, [broad])).status).toBe(400);

      // Refused values and machines no member claims.
      expect((await put(owner, MACHINE_ID, 'not a list')).status).toBe(400);
      expect((await put(owner, 'm_nobody_claims', ['plans'])).status).toBe(404);

      // The machine caches the answer one file per Deployment: another Deployment's cache is left as it was.
      const elsewhere = 'https://elsewhere.parity.example';
      cacheMachineSettings(elsewhere, { leaves: { [LEAF]: ['~/other-deployment'] } }, home);
      writeDeploymentMembership({ serverUrl: target.url, token: target.memberToken, machineId: MACHINE_ID, joinedAt: now, updatedAt: now }, { mycoHome: home });
      const seeded = await seedMachineSettings({ serverUrl: target.url, token: target.memberToken }, {
        mycoHome: home,
        fetch: ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' } })) as typeof fetch,
      });
      expect(seeded).toBe(true);
      expect({ here: machinePlanDirs(target.url, home), there: machinePlanDirs(elsewhere, home) })
        .toEqual({ here: ['~/notes/plans', 'docs/plans'], there: ['~/other-deployment'] });
      expect(fs.existsSync(machineSettingsPath(target.url, home))).toBe(true);

      // The default resets a leaf: no row is kept for it.
      expect((await put(owner, MACHINE_ID, [])).status).toBe(200);
      expect(await target.sql(`SELECT COUNT(*) AS n FROM machine_settings WHERE machine_id = ${lit(MACHINE_ID)}`)).toEqual([{ n: 0 }]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      await target.sql(`DELETE FROM machine_settings WHERE machine_id IN (${lit(MACHINE_ID)}, ${lit(otherMachine)})`);
      if (claimed) await target.sql(`DELETE FROM machine_claims WHERE machine_id = ${lit(MACHINE_ID)}`);
      if (otherMember !== null) {
        await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(otherMember)} AND revoked_at IS NULL`);
        await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(otherMember)}`);
      }
    }
  },
};
