import { describe, it, expect } from 'bun:test';
import { scopePolicyForPath, tierAllowsPath, pruneToTier } from '../../packages/myco/src/config/scope';

describe('scope registry', () => {
  it('resolves a leaf via longest-prefix match (block entry covers subtree)', () => {
    expect(scopePolicyForPath('notifications.domains.skills.mode'))
      .toEqual({ home: 'machine', overridableBy: ['local'] });
  });
  it('locks capture/embedding/appearance to a single tier (no override)', () => {
    expect(scopePolicyForPath('capture.plan_dirs').overridableBy).toEqual([]);
    expect(scopePolicyForPath('embedding.model').overridableBy).toEqual([]);
    expect(scopePolicyForPath('appearance.mode').overridableBy).toEqual([]);
  });
  it('update channel is machine-scoped with no override (decision-46130740)', () => {
    expect(scopePolicyForPath('daemon.update_channel')).toEqual({ home: 'machine', overridableBy: [] });
  });
  it('tierAllowsPath: machine owns capture; grove/local do not', () => {
    expect(tierAllowsPath('machine', 'capture.plan_dirs')).toBe(true);
    expect(tierAllowsPath('grove', 'capture.plan_dirs')).toBe(false);
    expect(tierAllowsPath('local', 'capture.plan_dirs')).toBe(false);
  });
  it('tierAllowsPath: agent.provider is grove home + local override', () => {
    expect(tierAllowsPath('grove', 'agent.provider')).toBe(true);
    expect(tierAllowsPath('local', 'agent.provider')).toBe(true);
    expect(tierAllowsPath('machine', 'agent.provider')).toBe(false);
  });
  it('pruneToTier drops leaves the tier does not own', () => {
    const projectRaw = { capture: { plan_dirs: ['x'] }, cortex: { digest_tier: 3 } };
    expect(pruneToTier(projectRaw, 'project')).toEqual({ cortex: { digest_tier: 3 } });
  });
  it('agent.semantic_write_check_enabled is grove home + local override — NOT scheduled_tasks_enabled\'s grove-lock', () => {
    // Deliberate deviation (Task 5): .myco/local.yaml is the per-machine
    // staging path the Phase 0 gate and dogfooding rely on, so this leaf is
    // NOT locked the way agent.scheduled_tasks_enabled/event_tasks_enabled are.
    expect(scopePolicyForPath('agent.semantic_write_check_enabled'))
      .toEqual({ home: 'grove', overridableBy: ['local'] });
    expect(tierAllowsPath('grove', 'agent.semantic_write_check_enabled')).toBe(true);
    expect(tierAllowsPath('local', 'agent.semantic_write_check_enabled')).toBe(true);
    expect(tierAllowsPath('machine', 'agent.semantic_write_check_enabled')).toBe(false);
    expect(tierAllowsPath('project', 'agent.semantic_write_check_enabled')).toBe(false);
  });
  it('pruneToTier retains agent.semantic_write_check_enabled at the grove tier (regression: dogfood gotcha)', () => {
    // Before Task 5, grove.yaml silently pruned this field on every merge
    // because SCOPE_REGISTRY had no leaf/block entry recognizing it as
    // grove-owned (it lived only in AgentBaseSchema). Guard the fix.
    const groveRaw = { agent: { semantic_write_check_enabled: true } };
    expect(pruneToTier(groveRaw, 'grove')).toEqual({ agent: { semantic_write_check_enabled: true } });
  });
  it('pruneToTier retains agent.semantic_write_check_enabled at the local tier (staging override)', () => {
    const localRaw = { agent: { semantic_write_check_enabled: false } };
    expect(pruneToTier(localRaw, 'local')).toEqual({ agent: { semantic_write_check_enabled: false } });
  });
  it('pruneToTier still drops agent.semantic_write_check_enabled at the machine tier (unknown-field behavior unchanged)', () => {
    const machineRaw = { agent: { semantic_write_check_enabled: true }, capture: { plan_dirs: ['x'] } };
    expect(pruneToTier(machineRaw, 'machine')).toEqual({ capture: { plan_dirs: ['x'] } });
  });
});
