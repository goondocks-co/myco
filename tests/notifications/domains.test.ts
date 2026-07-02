import { describe, it, expect, beforeEach } from 'bun:test';
import { registerBuiltinDomains } from '@myco/notifications/domains.js';
import { getType, clearAll } from '@myco/notifications/registry.js';

describe('agent.write.flagged notification type', () => {
  beforeEach(() => {
    // Clear registry before each test to ensure clean state
    clearAll();
    // registerBuiltinDomains is idempotent-guarded elsewhere in the app's
    // boot sequence; we can safely call it here.
    registerBuiltinDomains();
  });

  it('is registered under the agents domain with error-level default', () => {
    const match = getType('agent.write.flagged');
    expect(match).toBeDefined();
    expect(match!.domain.domain).toBe('agents');
    expect(match!.type.defaultLevel).toBe('error');
    expect(match!.type.defaultMode).toBe('banner');
  });
});
