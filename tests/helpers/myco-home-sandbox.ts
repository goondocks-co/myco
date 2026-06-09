import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Point MYCO_HOME at a fresh temp dir so a test can exercise real
 * path-resolution code (daemon.json fixtures, service dirs, grove
 * registries) without ever touching the machine's ~/.myco — a real
 * daemon.json write there points capture hooks at a dead port and gets
 * the production daemon restarted. Call restore() in afterEach; it
 * reinstates the prior env value and removes the sandbox dir.
 */
export function sandboxMycoHome(prefix = 'myco-home-sandbox-'): {
  mycoHome: string;
  restore: () => void;
} {
  const previous = process.env.MYCO_HOME;
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.MYCO_HOME = mycoHome;
  return {
    mycoHome,
    restore() {
      if (previous === undefined) delete process.env.MYCO_HOME;
      else process.env.MYCO_HOME = previous;
      fs.rmSync(mycoHome, { recursive: true, force: true });
    },
  };
}
