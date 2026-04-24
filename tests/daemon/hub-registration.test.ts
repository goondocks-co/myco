import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { buildHubProjectMetadata } from '@myco/daemon/hub-registration.js';

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
});
