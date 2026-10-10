import { describe, expect, it } from 'bun:test';
import path from 'node:path';
import { defaultSpec, renderUnit, SERVER_UNIT, servicePathEnv, servicePaths } from '@myco/server/service.js';

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
