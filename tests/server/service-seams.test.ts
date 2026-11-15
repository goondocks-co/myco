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
  let readFailure: Error | undefined;
  const options = { platform: target, runner: (command: string, args: readonly string[]) => {
    const read = (command === 'launchctl' && args[0] === 'print') || args.includes('--property=LoadState,Environment') || args.includes('/XML') && args[0] === '/Query';
    if (read && platform.loaded.has(name) && readFailure !== undefined) return { status: null, error: readFailure };
    if (read && platform.loaded.has(name)) return target === 'win32'
      ? { status: 0, stdoutBytes: Buffer.from(registered, 'utf16le') } : { status: 0, stdout: registered };
    return platform.runner(command, args);
  } };
  try {
    installService(owner, options);
    registered = target === 'darwin' ? `gui/501/${name} = {\n environment = {\n${legacy ? '' : `MYCO_HOME => ${owningHome}\n`}}\n}`
      : target === 'linux' ? `LoadState=loaded\nEnvironment=${legacy ? '' : `MYCO_HOME=${owningHome}`}`
      : `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
<Actions Context="Author"><Exec><Command>cmd.exe</Command>
<Arguments>/c ${legacy ? '' : `set "MYCO_HOME=${owningHome}" &amp;&amp; `}"C:\\Program Files\\Myco\\myco.exe" server run --target local</Arguments>
</Exec></Actions></Task>`;
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
    fs.rmSync(servicePaths(owner, target).unitFile);
    readFailure = new Error('registration query timed out');
    expect(() => installService(owner, options)).toThrow('ownership could not be read (registration query timed out)');
    try { installService(owner, options); } catch (error) {
      expect(String(error)).not.toContain('repair access');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
