import { describe, expect, it } from 'bun:test';

import {
  headscaleLayout,
  mintPreauthKey,
  parsePreauthKey,
  parseUserId,
  renderHeadscaleConfig,
} from '../../packages/myco-team/src/host/headscale-config.js';
import type { CommandRunner } from '../../packages/myco-team/src/host/binaries.js';

describe('renderHeadscaleConfig', () => {
  const layout = headscaleLayout('/home/x/.myco-team/host');
  const config = renderHeadscaleConfig({
    serverUrl: 'https://host.example:8080',
    listenAddr: '0.0.0.0:8080',
    layout,
  });

  it('derives server_url from the overlay-reachable address', () => {
    expect(config).toContain('server_url: https://host.example:8080');
    expect(config).toContain('listen_addr: 0.0.0.0:8080');
  });

  it('roots sqlite state + the noise key under the myco-team host-control home', () => {
    expect(config).toContain('path: /home/x/.myco-team/host/headscale/db.sqlite');
    expect(config).toContain('private_key_path: /home/x/.myco-team/host/headscale/noise_private.key');
    // The layout paths are all under the host-control home, never a system dir.
    expect(layout.stateDir).toBe('/home/x/.myco-team/host/headscale');
    expect(layout.configPath).toBe('/home/x/.myco-team/host/headscale/config.yaml');
  });

  it('documents the Tailscale-Inc DERP-default posture honestly and keeps embedded DERP off', () => {
    expect(config).toMatch(/Tailscale Inc's public DERP fleet/);
    expect(config).toContain('enabled: false'); // embedded DERP server off
    expect(config).toContain('100.64.0.0/10'); // CGNAT overlay range
  });
});

describe('mintPreauthKey', () => {
  function recordingRunner(handlers: Record<string, { stdout: string; exitCode: number }>): {
    runner: CommandRunner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      async run(command: string, args: string[]) {
        calls.push([command, ...args]);
        const key = args.join(' ');
        for (const [pattern, result] of Object.entries(handlers)) {
          if (key.includes(pattern)) return result;
        }
        return { stdout: '', exitCode: 0 };
      },
    };
    return { runner, calls };
  }

  it('ensures the user, resolves its id, and mints a one-time key with the pinned syntax', async () => {
    const { runner, calls } = recordingRunner({
      'users create': { stdout: '{"id":"7","name":"myco-host"}', exitCode: 0 },
      'users list': { stdout: '[{"id":"7","name":"myco-host"}]', exitCode: 0 },
      'preauthkeys create': { stdout: '{"key":"abc123def456key"}', exitCode: 0 },
    });

    const key = await mintPreauthKey({
      headscaleBin: '/bin/headscale',
      configPath: '/cfg/config.yaml',
      user: 'myco-host',
      expiration: '1h',
      runner,
    });

    expect(key).toBe('abc123def456key');
    // preauthkeys create references the user by resolved numeric id, one-time (no --reusable).
    const mintCall = calls.find((c) => c.includes('preauthkeys'))!;
    expect(mintCall).toEqual([
      '/bin/headscale', '--config', '/cfg/config.yaml',
      'preauthkeys', 'create', '--user', '7', '--expiration', '1h', '--output', 'json',
    ]);
    expect(mintCall).not.toContain('--reusable');
  });

  it('tolerates an already-existing user (idempotent re-enable)', async () => {
    const { runner } = recordingRunner({
      'users create': { stdout: 'error: user already exists', exitCode: 1 },
      'users list': { stdout: '[{"id":"3","name":"myco-host"}]', exitCode: 0 },
      'preauthkeys create': { stdout: '{"key":"reuse-mint-key-value"}', exitCode: 0 },
    });
    const key = await mintPreauthKey({
      headscaleBin: 'headscale', configPath: '/c.yaml', user: 'myco-host', expiration: '2h', runner,
    });
    expect(key).toBe('reuse-mint-key-value');
  });

  it('throws when the user cannot be resolved after create', async () => {
    const { runner } = recordingRunner({
      'users create': { stdout: '{}', exitCode: 0 },
      'users list': { stdout: '[]', exitCode: 0 },
    });
    await expect(mintPreauthKey({
      headscaleBin: 'headscale', configPath: '/c.yaml', user: 'ghost', expiration: '1h', runner,
    })).rejects.toThrow(/not found after create/);
  });
});

describe('parse helpers', () => {
  it('parseUserId finds by name across array + {users:[]} shapes', () => {
    expect(parseUserId('[{"id":"5","name":"a"},{"id":9,"name":"b"}]', 'b')).toBe(9);
    expect(parseUserId('{"users":[{"id":"2","name":"c"}]}', 'c')).toBe(2);
    expect(parseUserId('not json', 'x')).toBeNull();
  });

  it('parsePreauthKey handles the JSON object and a bare-key fallback', () => {
    expect(parsePreauthKey('{"key":"deadbeefcafebabe"}')).toBe('deadbeefcafebabe');
    expect(parsePreauthKey('deadbeefcafebabe0123')).toBe('deadbeefcafebabe0123');
    expect(parsePreauthKey('{"nope":true}')).toBeNull();
  });
});
