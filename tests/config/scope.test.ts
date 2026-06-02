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
});
