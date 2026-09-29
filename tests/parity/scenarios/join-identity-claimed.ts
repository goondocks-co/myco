import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REJOIN_HINT } from '@goondocks/myco-shared/member-protocol';
import { run as login } from '@myco/cli/login.js';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * A join refused because the machine identity belongs to another member writes nothing, on both targets (#1209):
 * the `members` count is unchanged and the invitation stays open and redeemable, whether the refusal comes over
 * `POST /members/join` or through `myco login`.
 */
export const joinIdentityClaimed: ParityScenario = {
  name: 'a join refused as identity_claimed writes no member and leaves the invitation redeemable, over the route and myco login',
  async run(target: ParityTarget) {
    const now = Date.now();
    const held = `m_parity_held_${now}`;
    const owner = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const invite = async (): Promise<{ key: string; id: string }> => {
      const res = await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: owner, body: JSON.stringify({ role: 'member' }) });
      expect(res.status).toBe(201);
      return await res.json() as { key: string; id: string };
    };
    const joinAs = async (key: string, machineId: string) =>
      (await fetch(`${target.url}/members/join`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' }, body: JSON.stringify({ key, machineId }),
      })).json() as Promise<{ joined: boolean; code?: string; memberId?: string }>;
    const members = async () => Number((await target.sql('SELECT COUNT(*) AS n FROM members'))[0]!.n);
    const open = async (id: string) => (await target.sql(`SELECT used_at FROM enrollment_authorities WHERE id = ${lit(id)}`))[0]!.used_at === null;

    const created: string[] = [];
    const home = mkdtempSync(join(tmpdir(), 'myco-parity-join-'));
    try {
      const first = await joinAs((await invite()).key, held);
      expect(first.joined).toBe(true);
      created.push(first.memberId!);

      // A second invitation, for a new member, presented by the machine the first member holds.
      const contested = await invite();
      const before = await members();
      expect(await joinAs(contested.key, held)).toMatchObject({ joined: false, code: 'identity_claimed' });
      expect({ members: await members(), open: await open(contested.id) }).toEqual({ members: before, open: true });

      // The same refusal through `myco login`, which names the one remedy and writes nothing either.
      const err: string[] = [];
      const signedIn = await login([`${target.url}/join#${contested.key}`], {
        mycoHome: home, cwd: home, machineId: held, stdout: () => {}, stderr: (line) => { err.push(line); },
        fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
          fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' } })) as typeof fetch,
      });
      expect(signedIn).toBe(false);
      expect(err.join('\n')).toContain(`(identity_claimed) — ${REJOIN_HINT}`);
      expect({ members: await members(), open: await open(contested.id) }).toEqual({ members: before, open: true });

      // Redeemable in fact: another machine takes the same invitation.
      const other = await joinAs(contested.key, `m_parity_other_${now}`);
      expect(other.joined).toBe(true);
      created.push(other.memberId!);
      expect({ members: await members(), open: await open(contested.id) }).toEqual({ members: before + 1, open: false });
    } finally {
      rmSync(home, { recursive: true, force: true });
      if (created.length > 0) {
        const ids = created.map(lit).join(', ');
        await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id IN (${ids}) AND revoked_at IS NULL`);
        await target.sql(`UPDATE members SET revoked_at = ${Date.now()} WHERE id IN (${ids}) AND revoked_at IS NULL`);
      }
    }
  },
};
