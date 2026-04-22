/**
 * Tests for the collective_settings tool handler. Proxies through
 * DaemonClient to GET /api/collective/settings.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleCollectiveSettings } from '@myco/mcp/tools/collective.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('collective_settings', () => {
  it('returns settings_overrides from the daemon', async () => {
    const settings_overrides = { 'digest.tier': 10000, 'retention.days': 90 };
    const client = mockClient({ settings_overrides });

    const result = await handleCollectiveSettings(client);

    expect(result).toEqual({ settings_overrides });
    expect(client.get).toHaveBeenCalledWith('/api/collective/settings');
  });

  it('returns empty overrides on daemon failure', async () => {
    const client = mockClient(null, false);
    const result = await handleCollectiveSettings(client);
    expect(result).toEqual({ settings_overrides: {} });
  });

  it('returns empty overrides when daemon returns no settings_overrides field', async () => {
    const client = mockClient({});
    const result = await handleCollectiveSettings(client);
    expect(result).toEqual({ settings_overrides: {} });
  });
});
