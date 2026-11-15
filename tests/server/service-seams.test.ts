import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { recordingPlatform } from '../helpers/fake-service-manager.js';
import { defaultSpec, installService, startService, stopService, uninstallService, renderUnit, SERVER_UNIT, servicePathEnv, servicePaths } from '@myco/server/service.js';

describe('native service specification seam', () => {
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    it(`keeps the production default specification unchanged on ${platform}`, () => {
      const home = '/service-fixture/user';
      const binaryPath = '/service-fixture/bin/myco';
      expect(defaultSpec(binaryPath, home, platform)).toEqual({
        unit: SERVER_UNIT, binaryPath, home,
        pathEnv: servicePathEnv(binaryPath, home, platform),
        logDir: path.join(home, '.myco', 'logs'), env: {},
      });
    });

    it(`carries an explicitly supplied Myco home through the rendered ${platform} unit`, () => {
      const mycoHome = '/service-fixture/isolated-myco';
      const spec = defaultSpec('/service-fixture/bin/myco', '/service-fixture/user', platform, mycoHome);
      expect(spec.env).toEqual({ MYCO_HOME: mycoHome });
      expect(spec.logDir).toBe(path.join(mycoHome, 'logs'));
      const unit = renderUnit(spec, servicePaths(spec, platform), platform);
      expect(unit).toContain('MYCO_HOME');
      expect(unit).toContain(mycoHome);
      expect(unit).toContain(path.join(mycoHome, 'logs', 'server.error.log'));
    });
  }
});

it('refuses every manual native service mutation from another home and preserves its owner', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-service-owner-'));
  const platform = recordingPlatform();
  const options = { platform: 'darwin' as const, runner: platform.runner };
  const owner = defaultSpec(path.join(root, 'myco'), root, 'darwin', path.join(root, 'owner'));
  const other = defaultSpec(owner.binaryPath, root, 'darwin', path.join(root, 'other'));
  try {
    installService(owner, options);
    for (const mutate of [installService, startService, stopService, uninstallService]) {
      expect(() => mutate(other, options)).toThrow(`owning home: ${owner.env.MYCO_HOME}`);
      expect(() => mutate(other, options)).toThrow('myco server uninstall --target local');
    }
    expect(platform.running.has(owner.unit.label)).toBe(true);
    uninstallService(owner, options);
    expect(platform.loaded.has(owner.unit.label)).toBe(false);
    installService(owner, options);
    fs.rmSync(servicePaths(owner, 'darwin').unitFile);
    expect(() => installService(other, options)).toThrow('owning home is unknown');
    expect(platform.running.has(owner.unit.label)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
