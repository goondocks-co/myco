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

for (const target of ['darwin', 'linux', 'win32'] as const) for (const legacy of [false, true]) it(`enforces ${target} ownership and recovers its missing ${legacy ? 'legacy' : 'explicit-home'} unit`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-service-owner-'));
  const platform = recordingPlatform();
  const owningHome = legacy ? path.join(root, '.myco') : path.join(root, 'owner');
  const owner = defaultSpec(path.join(root, 'myco'), root, target, legacy ? undefined : owningHome);
  const other = defaultSpec(owner.binaryPath, root, target, path.join(root, 'other'));
  const name = target === 'darwin' ? owner.unit.label : owner.unit.unitName;
  let registered = '';
  const options = { platform: target, runner: (command: string, args: readonly string[]) => {
    const read = (command === 'launchctl' && args[0] === 'print') || args.includes('--property=Environment') || args.includes('/XML') && args[0] === '/Query';
    if (read && platform.loaded.has(name)) return { status: 0, stdout: registered };
    return platform.runner(command, args);
  } };
  try {
    installService(owner, options);
    const xml = fs.readFileSync(servicePaths(owner, target).unitFile, 'utf8');
    registered = target === 'darwin' ? `gui/501/${name} = {\n environment = {\n${legacy ? '' : `MYCO_HOME => ${owningHome}\n`}}\n}`
      : target === 'linux' ? legacy ? '' : `MYCO_HOME=${owningHome}` : xml;
    for (const mutate of [installService, startService, stopService, uninstallService]) {
      expect(() => mutate(other, options)).toThrow(`owning home: ${owningHome}`);
    }
    fs.rmSync(servicePaths(owner, target).unitFile);
    expect(() => installService(other, options)).toThrow(`owning home: ${owningHome}`);
    expect(() => uninstallService(other, options)).toThrow(target === 'win32' ? `set "MYCO_HOME=${owningHome}" &&` : `MYCO_HOME=${owningHome}`);
    expect(uninstallService(owner, options).removed).toBe(true);
    expect(platform.loaded.has(name)).toBe(false);
    installService(owner, options);
    fs.rmSync(servicePaths(owner, target).unitFile);
    expect(installService(owner, options).running).toBe(true);
    expect(platform.running.has(name)).toBe(true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
