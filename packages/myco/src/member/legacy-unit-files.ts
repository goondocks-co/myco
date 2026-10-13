/** File-only discovery of retained Myco daemon units. */
import fs from 'node:fs';
import path from 'node:path';
import { parsePlistDocument, parseSystemdCommand, parseWindowsLauncherCommand, parseWindowsLauncherHome, type PlistValue } from '@myco/member/unit-parsers.js';
import { resolveBootServiceUnitDirs, resolveServiceUnitDir } from '@myco/paths/service-units.js';
export interface MycoUnit {
  label: string;
  file: string;
  executable: string;
  args: string[];
  home: string | null;
  scope: 'user' | 'boot';
}

const UNIT_FILE = /^co\.goondocks\.myco.*\.(plist|service|ps1)$/;

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

function readWindowsUnit(file: string, scope: MycoUnit['scope']): MycoUnit | null {
  const script = fs.readFileSync(file, 'utf8');
  const command = parseWindowsLauncherCommand(script);
  if (command === null) return null;
  return { ...command, label: path.basename(file, '.ps1'), file, home: parseWindowsLauncherHome(script), scope };
}

export function readMycoUnits(dir: string, scope: MycoUnit['scope']): MycoUnit[] {
  let names: string[];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names.filter((name) => UNIT_FILE.test(name)).flatMap((name) => {
    const file = path.join(dir, name);
    try {
      const unit = name.endsWith('.plist') ? readPlistUnit(file, scope)
        : name.endsWith('.ps1') ? readWindowsUnit(file, scope) : readSystemdUnit(file, scope);
      return unit === null ? [] : [unit];
    } catch { return []; }
  });
}

export const isDaemonUnit = (unit: MycoUnit): boolean =>
  /^myco(\.exe)?$/.test(path.win32.basename(unit.executable)) && unit.args[0] === 'daemon';

export function unitDirectories(env: NodeJS.ProcessEnv, homeDir: string, platform: NodeJS.Platform = process.platform): Array<{ dir: string; scope: MycoUnit['scope'] }> {
  const userDirs = [resolveServiceUnitDir({ env, homeDir, platform })];
  if (platform === 'win32' && !env.MYCO_LAUNCH_AGENTS_DIR?.trim() && env.MYCO_HOME?.trim()) {
    userDirs.push(path.join(env.MYCO_HOME, 'service'));
  }
  return [
    ...[...new Set(userDirs)].map(dir => ({ dir, scope: 'user' as const })),
    ...(env.MYCO_LAUNCH_AGENTS_DIR?.trim() ? [] : resolveBootServiceUnitDirs({ platform }).map((dir) => ({ dir, scope: 'boot' as const }))),
  ];
}
