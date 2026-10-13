import { WindowsTaskServiceManager, type SchtasksRunner } from './legacy-service/windows.js';
import { stopHomeDaemon, type DaemonStop } from './legacy-daemon-stop.js';
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
import { LaunchdServiceManager, type LaunchctlRunner } from './legacy-service/launchd.js';
import { SystemdUserServiceManager } from './legacy-service/systemd.js';
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
export function attributeLegacyUnits(dirs: ReadonlyArray<{ dir: string; scope: MycoUnit['scope'] }>, legacyHomes: readonly string[], platform: NodeJS.Platform = process.platform): UnitAttribution {
  const resolveHome = (home: string) => platform === 'win32' ? path.win32.resolve(home).toLowerCase() : path.resolve(home);
  const homes = new Set(legacyHomes.map(resolveHome));
  const seen = new Set<string>();
  const out: UnitAttribution = { stop: [], boot: [], unattributable: [] };
  for (const { dir, scope } of dirs) {
    for (const unit of readMycoUnits(dir, scope)) {
      const key = scope + ':' + (platform === 'win32' ? fs.realpathSync.native(unit.file).toLowerCase() : path.resolve(unit.file));
      if (seen.has(key)) continue;
      seen.add(key);
      if (!isDaemonUnit(unit)) continue;
      if (unit.home === null) { out.unattributable.push(unit); continue; }
      if (!homes.has(resolveHome(unit.home))) continue;
      (scope === 'boot' ? out.boot : out.stop).push(unit);
    }
  }
  return out;
}

/** Stop and remove one user-scope unit, touching no other unit. */
export async function stopUnit(unit: MycoUnit, platform: NodeJS.Platform = process.platform, runner?: LaunchctlRunner, windows: { runner?: SchtasksRunner; stopDaemon?: (home: string) => Promise<DaemonStop>; sleep?: (ms: number) => Promise<void>; backupTask?: (label: string, xml: string, previouslyDisabled: boolean) => void } = {}): Promise<void> {
  const dir = path.dirname(unit.file);
  if (unit.file.endsWith('.plist')) {
    await new LaunchdServiceManager({ agentsDir: dir, ...(runner ? { runner } : {}) }).uninstall(unit.label);
  } else if (platform === 'win32' && unit.file.endsWith('.ps1')) {
    if (unit.home === null) throw new Error(`Cannot stop unattributable Windows daemon unit ${unit.file}`);
    if (windows.backupTask === undefined) throw new Error('Windows daemon removal requires a Task Scheduler backup');
    const home = unit.home;
    await new WindowsTaskServiceManager({ runner: windows.runner, sleep: windows.sleep })
      .unregisterAfterDrain(unit.label, unit.file, () => (windows.stopDaemon ?? stopHomeDaemon)(home), windows.backupTask);
  } else if (platform === 'linux' && unit.file.endsWith('.service')) {
    await new SystemdUserServiceManager({ unitDir: dir }).uninstall(unit.label);
  } else {
    throw new Error(`Cannot stop ${unit.file} on ${platform}`);
  }
  // The file read is the one removed, whatever its name says its label is.
  fs.rmSync(unit.file, { force: true });
}
