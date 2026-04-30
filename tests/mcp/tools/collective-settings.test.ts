/**
 * Tests for the collective_settings tool handler. Proxies through
 * DaemonClient to GET /api/collective/settings.
 */

import { describe, it, expect, vi } from 'vitest';
import { handleCollectiveSettings } from '@myco/tools/collective.js';
import { DaemonClient } from '@myco/hooks/client.js';

function mockClient(data: unknown = null, ok = true): DaemonClient {
  return {
    get: vi.fn().mockResolvedValue({ ok, data }),
    post: vi.fn().mockResolvedValue({ ok, data }),
  } as unknown as DaemonClient;
}

describe('collective_settings', () => {
  it('maps daemon settings field to settings_overrides', async () => {
    // Daemon exposes { collective_enabled, settings, last_sync }; MCP tool
    // normalizes to the Collective-worker key `settings_overrides`.
    const settings = { 'digest.tier': 10000, 'retention.days': 90 };
    const client = mockClient({ collective_enabled: true, settings, last_sync: 1776883513 });

    const result = await handleCollectiveSettings(client);

    expect(result).toEqual({ settings_overrides: settings });
    expect(client.get).toHaveBeenCalledWith('/api/collective/settings');
  });

  it('returns empty overrides on daemon failure', async () => {
    const client = mockClient(null, false);
    const result = await handleCollectiveSettings(client);
    expect(result).toEqual({ settings_overrides: {} });
  });

  it('returns empty overrides when daemon returns no settings field', async () => {
    const client = mockClient({ collective_enabled: true });
    const result = await handleCollectiveSettings(client);
    expect(result).toEqual({ settings_overrides: {} });
  });
});
