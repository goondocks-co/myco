/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { stringify } from 'smol-toml';
import YAML from 'yaml';
import {
  ExternalMcpContainmentAuthority,
  ExternalMcpContainmentError,
  clearExternalMcpContainmentIntent,
  externalMcpContainmentIntentPath,
  readExternalMcpContainmentIntent,
  writeExternalMcpContainmentIntent,
  type ExternalMcpContainmentIntent,
} from '@myco/daemon/external-mcp-containment.js';
import { loadMachineConfig } from '@myco/config/loader.js';
import { writeSecret } from '@myco/config/secrets.js';
import { HOST_EXTERNAL_MCP_TOKEN_SECRET } from '@myco/constants.js';
import { writeHostServeConfig } from '@myco/team-host/daemon-apply.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { physicalPathLockIdentities } from '@myco/utils/physical-path-identity.js';

function stateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-external-mcp-containment-'));
}

function intent(
  overrides: Partial<ExternalMcpContainmentIntent> = {},
): ExternalMcpContainmentIntent {
  return {
    version: 1,
    operation: 'retire',
    from: { enabled: true, port: 8743 },
    to: { enabled: false, port: 8743 },
    ports: [8743],
    phase: 'funnel_off_pending',
    requested_at: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('external MCP containment intent', () => {
  test.skipIf(process.platform === 'win32')(
    'durably publishes and durably clears the intent',
    () => {
      const dir = stateDir();
      const intentPath = externalMcpContainmentIntentPath(dir);
      const events: string[] = [];
      const fdPaths = new Map<number, string>();
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const openSpy = spyOn(fs, 'openSync').mockImplementation(
        ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          const fd = originalOpen(target, flags, mode);
          fdPaths.set(fd, String(target));
          return fd;
        }) as typeof fs.openSync,
      );
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        events.push(`fsync:${fdPaths.get(fd) ?? 'unknown'}`);
        originalFsync(fd);
      });
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        events.push(`rename:${String(source)}:${String(destination)}`);
        originalRename(source, destination);
      });

      try {
        writeExternalMcpContainmentIntent(dir, intent());
        clearExternalMcpContainmentIntent(dir);
      } finally {
        renameSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
      }

      const publishIndex = events.findIndex((event) => event.endsWith(`:${intentPath}`));
      const publishSyncIndex = events.findIndex(
        (event, index) => index > publishIndex && event === `fsync:${dir}`,
      );
      const removalIndex = events.findIndex(
        (event, index) => index > publishSyncIndex && event.startsWith(`rename:${intentPath}:`),
      );
      expect(publishIndex).toBeGreaterThanOrEqual(0);
      expect(publishSyncIndex).toBeGreaterThan(publishIndex);
      expect(removalIndex).toBeGreaterThan(publishSyncIndex);
      expect(events.findIndex(
        (event, index) => index > removalIndex && event === `fsync:${dir}`,
      )).toBeGreaterThan(removalIndex);
    },
  );

  test('publishes a canonical owner-only intent and reads it back', () => {
    const dir = stateDir();

    writeExternalMcpContainmentIntent(dir, intent({
      ports: [9000, 8743, 9000],
    }));

    const intentPath = externalMcpContainmentIntentPath(dir);
    expect(fs.existsSync(intentPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(intentPath).mode & 0o777).toBe(0o600);
    }
    expect(readExternalMcpContainmentIntent(dir)).toEqual(intent({
      ports: [8743, 9000],
    }));
  });

  test('absence is the only state read as no intent', () => {
    expect(readExternalMcpContainmentIntent(stateDir())).toBeUndefined();
  });

  test.each([
    ['malformed TOML', 'version = [\n'],
    ['unsupported version', stringify({
      ...intent(),
      version: 2,
    } as unknown as Record<string, unknown>)],
    ['invalid operation', stringify({
      ...intent(),
      operation: 'enable',
    } as unknown as Record<string, unknown>)],
    ['invalid phase', stringify({
      ...intent(),
      phase: 'complete',
    } as unknown as Record<string, unknown>)],
    ['invalid source state', stringify({
      ...intent(),
      from: { enabled: 'yes', port: 8743 },
    } as unknown as Record<string, unknown>)],
    ['enabled target', stringify({
      ...intent(),
      to: { enabled: true, port: 8743 },
    } as unknown as Record<string, unknown>)],
    ['non-integer port', stringify({
      ...intent(),
      ports: [8743.5],
    } as unknown as Record<string, unknown>)],
    ['out-of-range port', stringify({
      ...intent(),
      ports: [1023],
    } as unknown as Record<string, unknown>)],
    ['empty ports', stringify({
      ...intent(),
      ports: [],
    } as unknown as Record<string, unknown>)],
    ['invalid timestamp', stringify({
      ...intent(),
      requested_at: 'not-a-timestamp',
    } as unknown as Record<string, unknown>)],
  ])('rejects %s and preserves the file', (_label, content) => {
    const dir = stateDir();
    const intentPath = externalMcpContainmentIntentPath(dir);
    fs.writeFileSync(intentPath, content);

    expect(() => readExternalMcpContainmentIntent(dir))
      .toThrow(ExternalMcpContainmentError);
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(content);
  });

  test.skipIf(process.platform === 'win32')(
    'rejects symlinks, directories, and special files without replacing them',
    () => {
      const cases: Array<{
        name: string;
        prepare: (target: string) => void;
        verify: (target: string) => boolean;
      }> = [
        {
          name: 'symlink',
          prepare: (target) => {
            const source = `${target}.source`;
            fs.writeFileSync(source, stringify(intent() as unknown as Record<string, unknown>));
            fs.symlinkSync(source, target);
          },
          verify: (target) => fs.lstatSync(target).isSymbolicLink(),
        },
        {
          name: 'directory',
          prepare: (target) => fs.mkdirSync(target),
          verify: (target) => fs.lstatSync(target).isDirectory(),
        },
        {
          name: 'FIFO',
          prepare: (target) => {
            const result = spawnSync('mkfifo', [target], { encoding: 'utf-8' });
            expect(result.status).toBe(0);
          },
          verify: (target) => fs.lstatSync(target).isFIFO(),
        },
      ];

      for (const entry of cases) {
        const dir = stateDir();
        const intentPath = externalMcpContainmentIntentPath(dir);
        entry.prepare(intentPath);

        expect(() => readExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(() => writeExternalMcpContainmentIntent(dir, intent()))
          .toThrow(ExternalMcpContainmentError);
        expect(() => clearExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(entry.verify(intentPath)).toBe(true);
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a socket without replacing it',
    async () => {
      const dir = stateDir();
      const intentPath = externalMcpContainmentIntentPath(dir);
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(intentPath, resolve);
      });

      try {
        expect(() => readExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(() => writeExternalMcpContainmentIntent(dir, intent()))
          .toThrow(ExternalMcpContainmentError);
        expect(() => clearExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(fs.lstatSync(intentPath).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  test('clears only when explicitly requested', () => {
    const dir = stateDir();
    writeExternalMcpContainmentIntent(dir, intent());
    const intentPath = externalMcpContainmentIntentPath(dir);

    expect(readExternalMcpContainmentIntent(dir)).toEqual(intent());
    expect(fs.existsSync(intentPath)).toBe(true);

    clearExternalMcpContainmentIntent(dir);
    expect(fs.existsSync(intentPath)).toBe(false);
    clearExternalMcpContainmentIntent(dir);
  });
});

interface FakeListener {
  readonly isBound: boolean;
  readonly port: number;
  unbind(): Promise<void>;
}

function containmentFixture(options: {
  enabled?: boolean;
  port?: number;
  listenerPort?: number;
} = {}): {
  home: string;
  serviceDir: string;
  listener: FakeListener & { unbindCalls: number };
} {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-external-mcp-authority-'));
  const serviceDir = path.join(home, 'service');
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.yaml'), YAML.stringify({
    machine_future: { keep: true },
    daemon: {
      daemon_future: 'preserved',
      external_mcp: {
        enabled: options.enabled ?? true,
        port: options.port ?? 8743,
        external_future: ['preserved'],
      },
    },
  }));
  let bound = options.listenerPort !== undefined;
  let boundPort = options.listenerPort ?? 0;
  const listener = {
    unbindCalls: 0,
    get isBound() { return bound; },
    get port() { return boundPort; },
    async unbind() {
      this.unbindCalls += 1;
      bound = false;
      boundPort = 0;
    },
  };
  return { home, serviceDir, listener };
}

describe('ExternalMcpContainmentAuthority', () => {
  test('journals every known port before Funnel-off and keeps the listener bound until all succeed', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 9100 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      ports: [8743, 9000],
    }));
    const events: string[] = [];
    const seenPorts: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: {
        get isBound() { return fixture.listener.isBound; },
        get port() { return fixture.listener.port; },
        async unbind() {
          events.push('unbind');
          await fixture.listener.unbind();
        },
      },
      runFunnelOff: async (port) => {
        const activeIntent = readExternalMcpContainmentIntent(fixture.serviceDir);
        expect(activeIntent?.phase).toBe('funnel_off_pending');
        expect(fixture.listener.isBound).toBe(true);
        events.push(`off:${port}`);
        seenPorts.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    const result = await authority.contain('disable', { additionalPorts: [9200, 9000] });

    expect(seenPorts).toEqual([8743, 9000, 9100, 9200]);
    expect(events).toEqual([
      'off:8743',
      'off:9000',
      'off:9100',
      'off:9200',
      'unbind',
    ]);
    expect(result).toEqual({
      enabled: false,
      port: 8743,
      funnel: [
        { ok: true, detail: 'off 8743' },
        { ok: true, detail: 'off 9000' },
        { ok: true, detail: 'off 9100' },
        { ok: true, detail: 'off 9200' },
      ],
    });
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
  });

  test('durably changes only enabled and preserves raw unknown siblings', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => ({ ok: true, detail: `off ${port}` }),
      lockNamespace: testPerUserLockNamespace,
    });

    await authority.contain('retire');

    const raw = YAML.parse(fs.readFileSync(path.join(fixture.home, 'config.yaml'), 'utf-8')) as {
      machine_future: { keep: boolean };
      daemon: {
        daemon_future: string;
        external_mcp: {
          enabled: boolean;
          port: number;
          external_future: string[];
        };
      };
    };
    expect(raw).toEqual({
      machine_future: { keep: true },
      daemon: {
        daemon_future: 'preserved',
        external_mcp: {
          enabled: false,
          port: 8743,
          external_future: ['preserved'],
        },
      },
    });
    expect(loadMachineConfig(fixture.home).daemon.external_mcp)
      .toEqual({ enabled: false, port: 8743 });
  });

  test.each([
    ['returned refusal', async () => ({ ok: false, detail: 'off refused' })],
    ['throw', async () => { throw new Error('off threw'); }],
    ['timeout', async () => await new Promise<{ ok: boolean; detail: string }>(() => {})],
    ['ambiguous result', async () => undefined as unknown as { ok: boolean; detail: string }],
  ])('retains the journal and listener when Funnel-off has an unconfirmed %s', async (
    _label,
    runFunnelOff,
  ) => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff,
      funnelOffTimeoutMs: 5,
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('funnel_off_pending');
    expect(fixture.listener.isBound).toBe(true);
    expect(fixture.listener.unbindCalls).toBe(0);
    expect(loadMachineConfig(fixture.home).daemon.external_mcp.enabled).toBe(true);
  });

  test('attempts every known port before reporting aggregate Funnel-off failures', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 9100 });
    const calls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        calls.push(port);
        return port === 8743
          ? { ok: false, detail: 'first refused' }
          : { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    let caught: unknown;
    try {
      await authority.contain('disable', { additionalPorts: [9200] });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    expect(calls).toEqual([8743, 9100, 9200]);
    expect(fixture.listener.isBound).toBe(true);
    expect(fixture.listener.unbindCalls).toBe(0);
  });

  test('retires the default brownfield port before blocking on corrupt machine config', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), 'daemon: [unterminated\n');
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743]);
    expect(fixture.listener.unbindCalls).toBe(1);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
  });

  test('retires an explicit custom port before blocking on an unrelated machine config error', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        log_level: 'invalid',
        external_mcp: {
          enabled: true,
          port: 9123,
        },
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743, 9123]);
    expect(fixture.listener.unbindCalls).toBe(1);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
  });

  test('replays a valid journal before corrupt config and retains config-disable recovery state', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      ports: [8743, 9100],
    }));
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), 'daemon: [unterminated\n');
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743, 9100]);
    expect(fixture.listener.unbindCalls).toBe(1);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
    expect(fs.readFileSync(path.join(fixture.home, 'config.yaml'), 'utf-8'))
      .toBe('daemon: [unterminated\n');
  });

  test('an unresolved port-recovery journal retires every known port before remaining unresolved', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 9100 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      phase: 'port_recovery_pending',
    }));
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        external_mcp: 'invalid',
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(
      authority.contain('retire', { additionalPorts: [9200] }),
    ).rejects.toThrow(/port.*recover/i);

    expect(offCalls).toEqual([8743, 9100, 9200]);
    expect(fixture.listener.isBound).toBe(true);
    expect(fixture.listener.unbindCalls).toBe(0);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toMatchObject({
      phase: 'port_recovery_pending',
      ports: [8743, 9100, 9200],
    });
  });

  test('an unresolved journal retains a valid raw port from an invalid external leaf', async () => {
    const fixture = containmentFixture({ port: 8743 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      phase: 'port_recovery_pending',
    }));
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        external_mcp: {
          enabled: 'invalid',
          port: 9123,
        },
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow(/port.*recover/i);

    expect(offCalls).toEqual([8743, 9123]);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toMatchObject({
      phase: 'port_recovery_pending',
      ports: [8743, 9123],
    });
  });

  test('resolves a port-recovery journal from the valid external leaf before unrelated config validation', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      phase: 'port_recovery_pending',
    }));
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        log_level: 'invalid',
        external_mcp: {
          enabled: true,
          port: 9123,
        },
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743, 9123]);
    expect(fixture.listener.unbindCalls).toBe(1);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
  });

  test('adds a recoverable custom port to a stale journal before unrelated config validation', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      phase: 'config_disable_pending',
    }));
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        log_level: 'invalid',
        external_mcp: {
          enabled: true,
          port: 9123,
        },
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743, 9123]);
    expect(fixture.listener.unbindCalls).toBe(1);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
  });

  test('an unbind failure retains the confirmed-off journal phase and enabled config', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: {
        get isBound() { return fixture.listener.isBound; },
        get port() { return fixture.listener.port; },
        async unbind() {
          throw new Error('unbind refused');
        },
      },
      runFunnelOff: async (port) => ({ ok: true, detail: `off ${port}` }),
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('shutdown')).rejects.toThrow(/unbind refused/);

    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('listener_unbind_pending');
    expect(fixture.listener.isBound).toBe(true);
    expect(loadMachineConfig(fixture.home).daemon.external_mcp.enabled).toBe(true);
  });

  test('a config failure after unbind retains config-disable recovery state', async () => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: {
        get isBound() { return fixture.listener.isBound; },
        get port() { return fixture.listener.port; },
        async unbind() {
          await fixture.listener.unbind();
          fs.writeFileSync(path.join(fixture.home, 'config.yaml'), 'daemon: [unterminated\n');
        },
      },
      runFunnelOff: async (port) => ({ ok: true, detail: `off ${port}` }),
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(readExternalMcpContainmentIntent(fixture.serviceDir)?.phase)
      .toBe('config_disable_pending');
    expect(fixture.listener.isBound).toBe(false);
  });

  test('disabled brownfield config still verifies Funnel-off at boot and shutdown', async () => {
    const fixture = containmentFixture({ enabled: false });
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await authority.contain('retire');
    await authority.contain('shutdown');

    expect(offCalls).toEqual([8743, 8743]);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
  });

  test('missing config with a legacy token contains every known port before remaining unresolved', async () => {
    const fixture = containmentFixture({ enabled: false, listenerPort: 9100 });
    fs.unlinkSync(path.join(fixture.home, 'config.yaml'));
    writeSecret(
      fixture.home,
      HOST_EXTERNAL_MCP_TOKEN_SECRET,
      'legacy-external-token',
      testPerUserLockNamespace,
    );
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(
      authority.contain('retire', { additionalPorts: [9200] }),
    ).rejects.toThrow(/port.*recover/i);

    expect(offCalls).toEqual([8743, 9100, 9200]);
    expect(fixture.listener.isBound).toBe(true);
    expect(fixture.listener.unbindCalls).toBe(0);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toMatchObject({
      phase: 'port_recovery_pending',
      ports: [8743, 9100, 9200],
    });
  });

  test('a valid custom port survives an otherwise invalid external MCP leaf', async () => {
    const fixture = containmentFixture({ enabled: false });
    fs.writeFileSync(path.join(fixture.home, 'config.yaml'), YAML.stringify({
      daemon: {
        external_mcp: {
          enabled: 'invalid',
          port: 9123,
        },
      },
    }));
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await expect(authority.contain('retire')).rejects.toThrow();

    expect(offCalls).toEqual([8743, 9123]);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toMatchObject({
      phase: 'config_disable_pending',
      ports: [8743, 9123],
    });
  });

  test('enabling Team Host on a sparse machine does not create external MCP evidence', async () => {
    const fixture = containmentFixture({ enabled: false });
    fs.unlinkSync(path.join(fixture.home, 'config.yaml'));
    writeHostServeConfig({
      enabled: true,
      overlayAddress: '100.64.0.10',
    }, fixture.home);
    const offCalls: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offCalls.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    const result = await authority.contain('retire');

    expect(offCalls).toEqual([]);
    expect(result).toEqual({
      enabled: false,
      port: 8743,
      funnel: [],
    });
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
  });

  test('a clean machine with no brownfield evidence does not require Tailscale', async () => {
    const fixture = containmentFixture({ enabled: false });
    fs.unlinkSync(path.join(fixture.home, 'config.yaml'));
    let offCalls = 0;
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async () => {
        offCalls += 1;
        return { ok: false, detail: 'tailscale unavailable' };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await authority.contain('retire');

    expect(offCalls).toBe(0);
  });

  test('mutually excludes a brownfield activation holding the legacy lock key', async () => {
    const fixture = containmentFixture({ enabled: false });
    const identity = physicalPathLockIdentities(fixture.home)[0]!;
    const key = crypto.createHash('sha256')
      .update(`external-mcp-activation\0${identity}`)
      .digest('hex');
    const lockPath = path.join(
      testPerUserLockNamespace.resolve('external-mcp-activation'),
      `${key}.lock`,
    );
    const held = LifecycleLock.acquire(lockPath, {
      command: 'legacy external-mcp activation',
    });
    expect(held.acquired).toBe(true);
    if (!held.acquired) throw new Error('legacy activation lock was not acquired');
    let offCalls = 0;
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async () => {
        offCalls += 1;
        return { ok: true, detail: 'off' };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    try {
      await expect(authority.contain('retire')).rejects.toThrow(/progress/i);
    } finally {
      held.lock.release();
    }

    expect(offCalls).toBe(0);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
  });

  test('holds the legacy activation lock through the post-containment continuation', async () => {
    const fixture = containmentFixture({ enabled: false });
    const identity = physicalPathLockIdentities(fixture.home)[0]!;
    const key = crypto.createHash('sha256')
      .update(`external-mcp-activation\0${identity}`)
      .digest('hex');
    const lockPath = path.join(
      testPerUserLockNamespace.resolve('external-mcp-activation'),
      `${key}.lock`,
    );
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => ({ ok: true, detail: `off ${port}` }),
      lockNamespace: testPerUserLockNamespace,
    });

    await authority.containWhile('retire', async () => {
      const overlappingActivation = LifecycleLock.acquire(lockPath, {
        command: 'legacy external-mcp activation',
      });
      expect(overlappingActivation.acquired).toBe(false);
    });

    const activationAfterHandoff = LifecycleLock.acquire(lockPath, {
      command: 'legacy external-mcp activation',
    });
    expect(activationAfterHandoff.acquired).toBe(true);
    if (activationAfterHandoff.acquired) activationAfterHandoff.lock.release();
  });

  test.skipIf(process.platform === 'win32')(
    'physical-home aliases serialize containment through one authority lock',
    async () => {
      const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
      const alias = path.join(
        fs.mkdtempSync(path.join(os.tmpdir(), 'myco-external-mcp-alias-')),
        'home',
      );
      fs.symlinkSync(fixture.home, alias, 'dir');
      let active = 0;
      let maxActive = 0;
      const runFunnelOff = async (port: number) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return { ok: true, detail: `off ${port}` };
      };
      const first = new ExternalMcpContainmentAuthority({
        mycoHome: fixture.home,
        stateDir: fixture.serviceDir,
        listener: fixture.listener,
        runFunnelOff,
        lockNamespace: testPerUserLockNamespace,
      });
      const second = new ExternalMcpContainmentAuthority({
        mycoHome: alias,
        stateDir: path.join(alias, 'service'),
        listener: fixture.listener,
        runFunnelOff,
        lockNamespace: testPerUserLockNamespace,
      });

      await Promise.all([
        first.contain('disable'),
        second.contain('disable'),
      ]);

      expect(maxActive).toBe(1);
    },
  );

  test('recovery refreshes a stale journal target to the current configured port', async () => {
    const fixture = containmentFixture({ port: 9000 });
    writeExternalMcpContainmentIntent(fixture.serviceDir, intent({
      to: { enabled: false, port: 8743 },
      ports: [8743],
      phase: 'config_disable_pending',
    }));
    const offPorts: number[] = [];
    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => {
        offPorts.push(port);
        return { ok: true, detail: `off ${port}` };
      },
      lockNamespace: testPerUserLockNamespace,
    });

    await authority.contain('retire');

    expect(offPorts).toEqual([8743, 9000]);
    expect(loadMachineConfig(fixture.home).daemon.external_mcp)
      .toEqual({ enabled: false, port: 9000 });
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
    expect((await authority.contain('retire')).funnel)
      .toEqual([{ ok: true, detail: 'off 9000' }]);
    expect(offPorts).toEqual([8743, 9000, 9000]);
  });

  test('an overlapping generic machine writer cannot resurrect enabled state', async () => {
    const fixture = containmentFixture({ port: 8743 });
    const readyPath = path.join(fixture.home, 'writer-ready');
    const helper = path.join(process.cwd(), 'tests/helpers/machine-config-writer-helper.ts');
    const child = spawn(
      process.execPath,
      ['run', helper, fixture.home, readyPath, '500'],
      {
        cwd: process.cwd(),
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
    const childExit = new Promise<void>((resolve, reject) => {
      child.on('exit', (code) => code === 0
        ? resolve()
        : reject(new Error(`machine config writer exited ${code}: ${stderr}`)));
      child.on('error', reject);
    });
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(readyPath)) {
      if (Date.now() >= deadline) {
        throw new Error(`machine config writer never acquired the lock: ${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    const authority = new ExternalMcpContainmentAuthority({
      mycoHome: fixture.home,
      stateDir: fixture.serviceDir,
      listener: fixture.listener,
      runFunnelOff: async (port) => ({ ok: true, detail: `off ${port}` }),
      lockNamespace: testPerUserLockNamespace,
    });
    const startedAt = Date.now();
    await authority.contain('retire');
    const blockedMs = Date.now() - startedAt;
    await childExit;

    const raw = YAML.parse(fs.readFileSync(path.join(fixture.home, 'config.yaml'), 'utf-8')) as {
      daemon: {
        log_level: string;
        external_mcp: { enabled: boolean; port: number };
      };
    };
    expect(blockedMs).toBeGreaterThanOrEqual(250);
    expect(raw.daemon.log_level).toBe('debug');
    expect(raw.daemon.external_mcp.enabled).toBe(false);
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
  }, 30_000);

  test.each([
    'journal_published',
    'off_side_effect',
    'listener_unbind',
    'config_commit',
    'journal_clear',
  ])('restart converges after a subprocess exit at %s', (crashAt) => {
    const fixture = containmentFixture({ port: 8743, listenerPort: 8743 });
    fs.writeFileSync(path.join(fixture.home, 'funnel.state'), 'active\n');
    fs.writeFileSync(path.join(fixture.home, 'listener.state'), 'bound\n');
    const helper = path.join(
      process.cwd(),
      'tests/helpers/external-mcp-containment-crash-helper.ts',
    );
    const crash = spawnSync(process.execPath, [helper], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        MYCO_TEST_HOME: fixture.home,
        MYCO_TEST_CRASH_AT: crashAt,
      },
    });
    expect(crash.status).toBe(91);

    const recovery = spawnSync(process.execPath, [helper], {
      cwd: process.cwd(),
      encoding: 'utf-8',
      env: {
        ...process.env,
        MYCO_TEST_HOME: fixture.home,
        MYCO_TEST_CRASH_AT: 'none',
      },
    });
    expect(recovery.status).toBe(0);
    expect(recovery.stderr).toBe('');
    expect(fs.readFileSync(path.join(fixture.home, 'funnel.state'), 'utf-8'))
      .toBe('off\n');
    expect(fs.readFileSync(path.join(fixture.home, 'listener.state'), 'utf-8'))
      .toBe('unbound\n');
    expect(loadMachineConfig(fixture.home).daemon.external_mcp)
      .toEqual({ enabled: false, port: 8743 });
    expect(readExternalMcpContainmentIntent(fixture.serviceDir)).toBeUndefined();
    expect(fs.readdirSync(fixture.serviceDir)
      .filter((entry) => entry.includes('intent.external-mcp.toml'))).toEqual([]);
  });
});
