import { describe, expect, test } from 'bun:test';
import { redactConfig } from '../../../packages/myco/src/capture/diagnostics/collect-system.js';

describe('redactConfig', () => {
  test('removes secret-bearing keys recursively, keeps structure', () => {
    const cfg = {
      daemon: { port: 4155, log_level: 'info' },
      intelligence: { api_key: 'sk-PLANTED', provider: 'anthropic' },
      team: { nested: { auth_token: 'PLANTED_TOKEN', password: 'PLANTED_PW', secret_thing: 'PLANTED' } },
    };
    const out = JSON.stringify(redactConfig(cfg));
    expect(out).not.toContain('PLANTED');
    expect(out).toContain('"port":4155');
    expect(out).toContain('"provider":"anthropic"');
    // redacted keys remain visible as redacted, so a bundle shows WHICH keys were set
    expect(out).toContain('"api_key":"[redacted]"');
  });
});
