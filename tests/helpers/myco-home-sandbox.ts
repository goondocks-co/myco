import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point MYCO_HOME and MYCO_TEAM_HOME at a fresh temp dir so a test can
 * exercise real path-resolution code (daemon.json fixtures, service dirs,
 * grove registries, team registry) without ever touching the machine's
 * ~/.myco or ~/.myco-team — a real daemon.json write there points capture
 * hooks at a dead port and gets the production daemon restarted. Also sets
 * MYCO_TEAM_LEGACY_HOMES='' so any test that boots initTeamSync cannot sweep
 * the developer's real ~/.myco/teams (defense-in-depth for raw `bun test`
 * runs outside the canonical runner, which sets this globally). Call
 * restore() in afterEach; it reinstates the prior env values and removes
 * the sandbox dir.
 */
export function sandboxMycoHome(prefix = 'myco-home-sandbox-'): { mycoHome: string; restore: () => void } {
  const previousHome = process.env.MYCO_HOME;
  const previousTeamHome = process.env.MYCO_TEAM_HOME;
  const previousLegacyHomes = process.env.MYCO_TEAM_LEGACY_HOMES;
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.MYCO_HOME = mycoHome;
  process.env.MYCO_TEAM_HOME = path.join(mycoHome, '__team_home__');
  process.env.MYCO_TEAM_LEGACY_HOMES = '';
  return {
    mycoHome,
    restore() {
      if (previousHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = previousHome;
      if (previousTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = previousTeamHome;
      if (previousLegacyHomes === undefined) delete process.env.MYCO_TEAM_LEGACY_HOMES; else process.env.MYCO_TEAM_LEGACY_HOMES = previousLegacyHomes;
      fs.rmSync(mycoHome, { recursive: true, force: true });
    },
  };
}
