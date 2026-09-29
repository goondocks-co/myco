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
import { LaunchdServiceManager, parsePlistDocument, type LaunchctlRunner, type PlistValue } from './launchd.js';
import { parseSystemdCommand, SystemdUserServiceManager } from './systemd.js';
import { resolveBootServiceUnitDirs, resolveServiceUnitDir } from './paths.js';

export interface MycoUnit {
  label: string;
  file: string;
  executable: string;
  args: string[];
  /** The home the unit serves, or null when neither `MYCO_HOME` nor its working directory says. */
  home: string | null;
  scope: 'user' | 'boot';
}

const UNIT_FILE = /^co\.goondocks\.myco.*\.(plist|service)$/;

const strings = (value: PlistValue | undefined): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? value as string[] : null;

function readPlistUnit(file: string, scope: MycoUnit['scope']): MycoUnit | null {
  const doc = parsePlistDocument(fs.readFileSync(file, 'utf8'));
  const argv = strings(doc?.ProgramArguments);
  if (!doc || !argv || argv.length === 0) return null;
  const env = doc.EnvironmentVariables && typeof doc.EnvironmentVariables === 'object' && !Array.isArray(doc.EnvironmentVariables)
    ? doc.EnvironmentVariables as Record<string, PlistValue> : {};
  const home = typeof env.MYCO_HOME === 'string' ? env.MYCO_HOME : typeof doc.WorkingDirectory === 'string' ? doc.WorkingDirectory : null;
  const label = typeof doc.Label === 'string' ? doc.Label : path.basename(file, '.plist');
  return { label, file, executable: argv[0], args: argv.slice(1), home, scope };
}

function readSystemdUnit(file: string, scope: MycoUnit['scope']): MycoUnit | null {
  const text = fs.readFileSync(file, 'utf8');
  const command = parseSystemdCommand(text);
  if (!command) return null;
  const env = [...text.matchAll(/^Environment=(.*)$/gm)].map((m) => m[1].replace(/^["']|["']$/g, ''));
  const home = env.find((e) => e.startsWith('MYCO_HOME='))?.slice('MYCO_HOME='.length)
    ?? /^WorkingDirectory=(.*)$/m.exec(text)?.[1]?.replace(/^["']|["']$/g, '') ?? null;
  return { label: path.basename(file, '.service'), file, executable: command.executable, args: command.args, home, scope };
}

/** Every Myco unit file in `dir`. A file that cannot be read is skipped. */
export function readMycoUnits(dir: string, scope: MycoUnit['scope']): MycoUnit[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => UNIT_FILE.test(name)).flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const unit = name.endsWith('.plist') ? readPlistUnit(file, scope) : readSystemdUnit(file, scope);
      return unit === null ? [] : [unit];
    } catch { return []; }
  });
}

/** Whether a unit runs the Myco daemon (not a worker, a server or anything else). */
export const isDaemonUnit = (unit: MycoUnit): boolean =>
  /^myco(\.exe)?$/.test(path.basename(unit.executable)) && unit.args[0] === 'daemon';

export interface UnitAttribution {
  /** Daemon units of a home being cut over, in the user's own scope: stopped and removed. */
  stop: MycoUnit[];
  /** Daemon units of a home being cut over that start at boot: they need an administrator. */
  boot: MycoUnit[];
  /** Daemon units whose home cannot be read. */
  unattributable: MycoUnit[];
}

/** The platform's unit directories, user scope first. */
export function unitDirectories(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform = process.platform): Array<{ dir: string; scope: MycoUnit['scope'] }> {
  return [
    { dir: resolveServiceUnitDir({ env, homeDir, platform }), scope: 'user' as const },
    ...(env.MYCO_LAUNCH_AGENTS_DIR?.trim() ? [] : resolveBootServiceUnitDirs({ platform }).map((dir) => ({ dir, scope: 'boot' as const }))),
  ];
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
