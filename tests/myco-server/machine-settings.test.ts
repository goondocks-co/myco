/**
 * A machine's settings on the Deployment (#1393): who reaches them, what a value may be, the default that resets a
 * leaf, and the block a machine is answered with.
 */
import { describe, expect, it } from 'bun:test';
import { machineAccess, machineBlockFor, readMachineSettings, setMachineLeaf } from '@myco-server-worker/core/machine-settings.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const NOW = 1_800_000_000_000;
/** The auto-join leaves a machine holds (#1547), at their defaults. */
const AT_DEFAULT = { 'capture.auto_join_roots': ['~/Repos'], 'capture.connect_roots': {} };
const DEFAULT_ROWS = [
  { leaf: 'capture.auto_join_roots', configured: false, value: ['~/Repos'], updatedAt: null, updatedBy: null },
  { leaf: 'capture.connect_roots', configured: false, value: {}, updatedAt: null, updatedBy: null },
];

function rig() {
  const e = sqliteEnv();
  for (const [id, role, github] of [['mem_admin', 'admin', '9100'], ['mem_a', 'member', '9101'], ['mem_b', 'member', '9102']] as const) {
    e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, ?, ?, ?)`, [id, id, NOW, role]);
    e.sqlite.run(`UPDATE members SET github_id = ? WHERE id = ?`, [github, id]);
  }
  e.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('m_a', 'mem_a', ?), ('m_b', 'mem_b', ?)`, [NOW, NOW]);
  return e;
}

describe('a machine\'s settings', () => {
  it('are reached by the member the machine belongs to, and by no other member, an admin included', async () => {
    const e = rig();
    expect(await machineAccess(e.db, 'mem_a', 'm_a')).toBe('allowed');
    expect(await machineAccess(e.db, 'mem_admin', 'm_a')).toBe('forbidden');
    expect(await machineAccess(e.db, 'mem_b', 'm_a')).toBe('forbidden');
    expect(await machineAccess(e.db, 'mem_admin', 'm_nobody')).toBe('absent');
    // The write itself is conditioned on the claim: a member who does not claim the machine neither sets nor resets it.
    await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans'], 'mem_a', NOW);
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['elsewhere'], 'mem_admin', NOW + 1)).toEqual({ applied: false, reason: 'absent' });
    await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', [], 'mem_admin', NOW + 2);
    expect(await machineBlockFor(e.db, 'mem_a', 'm_a')).toEqual({ leaves: { ...AT_DEFAULT, 'capture.plan_dirs': ['docs/plans'] } });
  });

  it('refuse a folder that is, or resolves to, the filesystem root, the home or the project root, and any that climbs out', async () => {
    const e = rig();
    const broad = ['/', '//', '/./', '~', '~/', '~/.', '~//', '.', './', './/.', '..', '../plans', 'docs/../../plans', '~/../plans', '/fixture/../etc', '~root/plans'];
    const refused = await Promise.all(broad.map(async (entry) => [entry, (await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', [entry], 'mem_a', NOW)).applied] as const));
    expect(Object.fromEntries(refused)).toEqual(Object.fromEntries(broad.map((entry) => [entry, false])));
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['./docs/plans', '~/notes/plans', '/srv/plans', 'a..b/plans'], 'mem_a', NOW)).toEqual({ applied: true });
  });

  it('hold capture folders to the one capture folder rule: a drive root and a relative folder refused, a Windows home folder kept', async () => {
    const e = rig();
    for (const entry of ['C:\\', 'C:/', 'C:\\\\', '/', '~', 'Repos']) {
      expect({ entry, write: await setMachineLeaf(e.db, 'm_a', 'capture.auto_join_roots', [entry], 'mem_a', NOW) }).toMatchObject({ entry, write: { applied: false, reason: 'invalid_value' } });
    }
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.auto_join_roots', ['~\\Repos', 'D:\\work', '/srv/repos'], 'mem_a', NOW)).toEqual({ applied: true });
    // A plan folder keeps its own rule: relative to each project is allowed there.
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans'], 'mem_a', NOW)).toEqual({ applied: true });
  });

  it('answer an admin who does not own the machine 403 on the dashboard, read and write alike, and write the path\'s machine whatever the body names', async () => {
    const e = rig();
    const env = { ...e.env, ...OWNER_ENV };
    const as = async (sub: string, method: string, path: string, body?: unknown) => worker.fetch(new Request(`https://s${path}`, {
      method, headers: { cookie: await ownerCookie(Date.now(), sub), 'cf-connecting-ip': '1.2.3.4', origin: 'https://s', 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }), env);
    expect((await as('9100', 'GET', '/api/machines/m_a/settings')).status).toBe(403);
    expect((await as('9100', 'PUT', '/api/machines/m_a/settings/capture.plan_dirs', { value: ['plans'] })).status).toBe(403);
    expect((await as('9102', 'GET', '/api/machines/m_a/settings')).status).toBe(403);
    expect((await as('9101', 'PUT', '/api/machines/m_a/settings/capture.plan_dirs', { value: ['plans'], machineId: 'm_b' })).status).toBe(200);
    expect({ a: await machineBlockFor(e.db, 'mem_a', 'm_a'), b: await machineBlockFor(e.db, 'mem_b', 'm_b') })
      .toEqual({ a: { leaves: { ...AT_DEFAULT, 'capture.plan_dirs': ['plans'] } }, b: { leaves: { ...AT_DEFAULT, 'capture.plan_dirs': [] } } });
    expect(e.sqlite.query(`SELECT machine_id FROM machine_settings`).all()).toEqual([{ machine_id: 'm_a' }]);
    expect((await as('9101', 'GET', '/api/machines/m_a/settings')).status).toBe(200);
  });

  it('take a list of paths, refuse anything else, and return to the default by being set to it', async () => {
    const e = rig();
    for (const bad of ['plans', [''], ['a', 'a'], ['bad\npath'], Array.from({ length: 17 }, (_, i) => `p${i}`), ['x'.repeat(257)]]) {
      expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', bad, 'mem_a', NOW)).toMatchObject({ applied: false, reason: 'invalid_value' });
    }
    expect(await setMachineLeaf(e.db, 'm_a', 'update.channel', 'beta', 'mem_a', NOW)).toEqual({ applied: false, reason: 'unknown_leaf' });
    expect(await setMachineLeaf(e.db, 'm_nobody', 'capture.plan_dirs', ['plans'], 'mem_a', NOW)).toEqual({ applied: false, reason: 'absent' });
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans', '~/notes', '/abs/plans'], 'mem_a', NOW)).toEqual({ applied: true });
    expect(await readMachineSettings(e.db, 'm_a')).toMatchObject([{ leaf: 'capture.plan_dirs', configured: true, value: ['docs/plans', '~/notes', '/abs/plans'], updatedAt: NOW, updatedBy: 'mem_a' }, ...DEFAULT_ROWS]);
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', [], 'mem_a', NOW + 1)).toEqual({ applied: true });
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM machine_settings`).get()).toEqual({ n: 0 });
    expect(await readMachineSettings(e.db, 'm_a')).toMatchObject([{ leaf: 'capture.plan_dirs', configured: false, value: [], updatedAt: null, updatedBy: null }, ...DEFAULT_ROWS]);
  });

  it('are answered to the member that claims the machine, and to nobody asking from a machine it does not claim', async () => {
    const e = rig();
    await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans'], 'mem_a', NOW);
    expect(await machineBlockFor(e.db, 'mem_a', 'm_a')).toEqual({ leaves: { ...AT_DEFAULT, 'capture.plan_dirs': ['docs/plans'] } });
    expect(await machineBlockFor(e.db, 'mem_b', 'm_a')).toBeNull();
    expect(await machineBlockFor(e.db, 'mem_b', 'm_b')).toEqual({ leaves: { ...AT_DEFAULT, 'capture.plan_dirs': [] } });
    // A run's credential names the harness member, which claims no machine.
    expect(await machineBlockFor(e.db, 'mem_harness', 'harness-runtime')).toBeNull();
  });
});
