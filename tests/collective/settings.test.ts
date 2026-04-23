import { describe, expect, it } from 'bun:test';
import {
  COLLECTIVE_SETTING_DEFINITIONS,
  validateCollectiveSetting,
} from '../../packages/myco-collective/worker/src/settings.js';

describe('collective setting definitions', () => {
  it('exposes a schema-backed allowlist of supported keys', () => {
    expect(COLLECTIVE_SETTING_DEFINITIONS.length).toBeGreaterThan(0);
    expect(COLLECTIVE_SETTING_DEFINITIONS.map((entry) => entry.key)).toContain('context.digest_tier');
    expect(COLLECTIVE_SETTING_DEFINITIONS.map((entry) => entry.key)).not.toContain('totally.unsupported.key');
  });

  it('rejects unsupported setting keys', () => {
    const result = validateCollectiveSetting('totally.unsupported.key', true);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('Expected unsupported setting validation to fail');
    }
    expect(result.error).toContain('Unsupported setting key');
  });

  it('validates allowed values by type and bounds', () => {
    expect(validateCollectiveSetting('agent.scheduled_tasks_enabled', true).ok).toBe(true);
    expect(validateCollectiveSetting('context.prompt_max_spores', 3).ok).toBe(true);
    expect(validateCollectiveSetting('context.prompt_max_spores', 11).ok).toBe(false);
    expect(validateCollectiveSetting('context.digest_tier', 5000).ok).toBe(true);
    expect(validateCollectiveSetting('context.digest_tier', 1234).ok).toBe(false);
    expect(validateCollectiveSetting('notifications.default_mode', 'banner').ok).toBe(true);
    expect(validateCollectiveSetting('notifications.default_mode', 'toast').ok).toBe(false);
  });
});
