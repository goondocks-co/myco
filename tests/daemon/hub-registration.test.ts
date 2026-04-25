import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { buildHubProjectMetadata, registerWithHub } from '@myco/daemon/hub-registration.js';

describe('daemon hub registration metadata', () => {
  it('uses project runtime.command as the runtime source of truth', () => {
    const projectRoot = '/tmp/myco-hub-reg-project';
    const vaultDir = path.join(projectRoot, '.myco');
    const readFileSync = vi.spyOn(fs, 'readFileSync').mockImplementation((filePath) => {
      if (filePath === path.join(vaultDir, 'runtime.command')) return '/tmp/myco-dev\n';
      if (filePath === path.join(vaultDir, 'daemon.json')) {
        return JSON.stringify({ started: '2026-04-24T00:00:00.000Z' });
      }
      throw new Error(`Unexpected read: ${String(filePath)}`);
    });

    try {
      const metadata = buildHubProjectMetadata({
        projectRoot,
        vaultDir,
        machineId: 'chris_12345678',
        port: 21039,
        version: '0.22.3',
      });

      expect(metadata.runtimeCommand).toBe('/tmp/myco-dev');
      expect(metadata.machineId).toBe('chris_12345678');
      expect(metadata.port).toBe(21039);
      expect(metadata.startedAt).toBe('2026-04-24T00:00:00.000Z');
    } finally {
      readFileSync.mockRestore();
    }
  });

  it('registers with the configured hub URL using JSON metadata', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('MYCO_HUB_URL', 'http://127.0.0.1:21000/');

    try {
      const metadata = {
        name: 'example',
        projectRoot: '/tmp/example',
        vaultDir: '/tmp/example/.myco',
        machineId: 'local_abc',
        port: 21039,
        pid: 1234,
        version: '0.22.3',
        startedAt: null,
        runtimeCommand: '/tmp/myco-dev',
      };

      await expect(registerWithHub(metadata)).resolves.toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('http://127.0.0.1:21000/api/daemon/register');
      expect(init.method).toBe('POST');
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' });
      expect(JSON.parse(String(init.body))).toEqual(metadata);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });

  it('returns false when hub registration fails', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 500 })));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(registerWithHub({
        name: 'example',
        projectRoot: '/tmp/example',
        vaultDir: '/tmp/example/.myco',
        machineId: 'local_abc',
        port: 21039,
        pid: 1234,
        version: '0.22.3',
        startedAt: null,
        runtimeCommand: null,
      })).resolves.toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('accepts an explicit hub URL from daemon config', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}', { status: 200 })));
    vi.stubGlobal('fetch', fetchMock);

    try {
      await expect(registerWithHub({
        name: 'example',
        projectRoot: '/tmp/example',
        vaultDir: '/tmp/example/.myco',
        machineId: 'local_abc',
        port: 21039,
        pid: 1234,
        version: '0.22.3',
        startedAt: null,
        runtimeCommand: null,
      }, 'http://localhost:21999/')).resolves.toBe(true);

      expect(fetchMock.mock.calls[0]?.[0]).toBe('http://localhost:21999/api/daemon/register');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
