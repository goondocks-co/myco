/**
 * The 1.4 daemon units a cutover stops, found by reading every
 * `co.goondocks.myco*` unit file rather than by computing a label: a label
 * depends on which home is the default, and a machine pin changes that.
 *
 * A unit is a Myco daemon when it runs `myco daemon`. Its home is the
 * `MYCO_HOME` it is given, else its working directory. A daemon unit of a
 * home being cut over is stopped and removed; a daemon unit whose home cannot
 * be read refuses the cutover; every other unit (another home's daemon, a
 * worker, a server) is left as it is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { LaunchdServiceManager, type LaunchctlRunner } from './launchd.js';
import { SystemdUserServiceManager } from './systemd.js';
import { readMycoUnits, isDaemonUnit, type MycoUnit } from '@myco/member/legacy-unit-files.js';
export { readMycoUnits, isDaemonUnit, unitDirectories, type MycoUnit } from '@myco/member/legacy-unit-files.js';

export interface UnitAttribution {
  /** Daemon units of a home being cut over, in the user's own scope: stopped and removed. */
  stop: MycoUnit[];
  /** Daemon units of a home being cut over that start at boot: they need an administrator. */
  boot: MycoUnit[];
  /** Daemon units whose home cannot be read. */
  unattributable: MycoUnit[];
}

/** Attribute every daemon unit in `dirs` to the 1.4 homes being cut over. */
export function attributeLegacyUnits(dirs: ReadonlyArray<{ dir: string; scope: MycoUnit['scope'] }>, legacyHomes: readonly string[]): UnitAttribution {
  const homes = new Set(legacyHomes.map((home) => path.resolve(home)));
  const out: UnitAttribution = { stop: [], boot: [], unattributable: [] };
  for (const { dir, scope } of dirs) {
    for (const unit of readMycoUnits(dir, scope)) {
      if (!isDaemonUnit(unit)) continue;
      if (unit.home === null) { out.unattributable.push(unit); continue; }
      if (!homes.has(path.resolve(unit.home))) continue;
      (scope === 'boot' ? out.boot : out.stop).push(unit);
    }
  }
  return out;
}

/** Stop and remove one user-scope unit, touching no other unit. */
export async function stopUnit(unit: MycoUnit, platform: NodeJS.Platform = process.platform, runner?: LaunchctlRunner): Promise<void> {
  const dir = path.dirname(unit.file);
  if (unit.file.endsWith('.plist')) {
    await new LaunchdServiceManager({ agentsDir: dir, pruneOnUninstall: false, ...(runner ? { runner } : {}) }).uninstall(unit.label);
  } else if (platform === 'linux') {
    await new SystemdUserServiceManager({ unitDir: dir }).uninstall(unit.label);
  }
  // The file read is the one removed, whatever its name says its label is.
  fs.rmSync(unit.file, { force: true });
}
