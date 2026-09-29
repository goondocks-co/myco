/**
 * A machine's settings on the Deployment (#1393): who reaches them, what a value may be, the default that resets a
 * leaf, and the block a machine is answered with.
 */
import { describe, expect, it } from 'bun:test';
import { machineAccess, machineBlockFor, readMachineSettings, setMachineLeaf } from '@myco-server-worker/core/machine-settings.js';
import { sqliteEnv } from './helpers/fixtures.js';

const NOW = 1_800_000_000_000;

function rig() {
  const e = sqliteEnv();
  for (const [id, role] of [['mem_admin', 'admin'], ['mem_a', 'member'], ['mem_b', 'member']] as const) {
    e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, ?, ?, ?)`, [id, id, NOW, role]);
  }
  e.sqlite.run(`INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES ('m_a', 'mem_a', ?), ('m_b', 'mem_b', ?)`, [NOW, NOW]);
  return e;
}

describe('a machine\'s settings', () => {
  it('are reached by an admin and by the member the machine belongs to, and by no other member', async () => {
    const e = rig();
    expect(await machineAccess(e.db, { id: 'mem_admin', role: 'admin' }, 'm_a')).toBe('allowed');
    expect(await machineAccess(e.db, { id: 'mem_a', role: 'member' }, 'm_a')).toBe('allowed');
    expect(await machineAccess(e.db, { id: 'mem_b', role: 'member' }, 'm_a')).toBe('forbidden');
    expect(await machineAccess(e.db, { id: 'mem_admin', role: 'admin' }, 'm_nobody')).toBe('absent');
  });

  it('take a list of paths, refuse anything else, and return to the default by being set to it', async () => {
    const e = rig();
    for (const bad of ['plans', [''], ['a', 'a'], ['bad\npath'], Array.from({ length: 17 }, (_, i) => `p${i}`), ['x'.repeat(257)]]) {
      expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', bad, 'mem_a', NOW)).toMatchObject({ applied: false, reason: 'invalid_value' });
    }
    expect(await setMachineLeaf(e.db, 'm_a', 'update.channel', 'beta', 'mem_a', NOW)).toEqual({ applied: false, reason: 'unknown_leaf' });
    expect(await setMachineLeaf(e.db, 'm_nobody', 'capture.plan_dirs', ['plans'], 'mem_a', NOW)).toEqual({ applied: false, reason: 'absent' });
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans', '~/notes', '/abs/plans'], 'mem_a', NOW)).toEqual({ applied: true });
    expect(await readMachineSettings(e.db, 'm_a')).toEqual([{ leaf: 'capture.plan_dirs', configured: true, value: ['docs/plans', '~/notes', '/abs/plans'], updatedAt: NOW, updatedBy: 'mem_a' }]);
    expect(await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', [], 'mem_a', NOW + 1)).toEqual({ applied: true });
    expect(e.sqlite.query(`SELECT COUNT(*) AS n FROM machine_settings`).get()).toEqual({ n: 0 });
    expect(await readMachineSettings(e.db, 'm_a')).toEqual([{ leaf: 'capture.plan_dirs', configured: false, value: [], updatedAt: null, updatedBy: null }]);
  });

  it('are answered to the member that claims the machine, and to nobody asking from a machine it does not claim', async () => {
    const e = rig();
    await setMachineLeaf(e.db, 'm_a', 'capture.plan_dirs', ['docs/plans'], 'mem_a', NOW);
    expect(await machineBlockFor(e.db, 'mem_a', 'm_a')).toEqual({ leaves: { 'capture.plan_dirs': ['docs/plans'] } });
    expect(await machineBlockFor(e.db, 'mem_b', 'm_a')).toBeNull();
    expect(await machineBlockFor(e.db, 'mem_b', 'm_b')).toEqual({ leaves: { 'capture.plan_dirs': [] } });
    // A run's credential names the harness member, which claims no machine.
    expect(await machineBlockFor(e.db, 'mem_harness', 'harness-runtime')).toBeNull();
  });
});
