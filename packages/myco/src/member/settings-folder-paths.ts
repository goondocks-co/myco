/**
 * Where a harness's manifest home paths land when a person moves its settings folder: a path under the default
 * folder, or one the declaration carries, moves into the folder; any other path stays where the manifest puts it.
 * Reads nothing beyond the provision record and the environment, so the hooks can use it.
 */
import path from 'node:path';
import { expandHome } from '../paths/home.js';
import { BUNDLED_MANIFESTS } from '../symbionts/manifests.generated.js';
import { readProvisionRecord } from './provision-record.js';

/**
 * How Myco knows of a folder. `default` is the harness's own; `variable` is named by the harness's variable in this
 * environment; `recorded` was named by the person or set up before. Myco writes only into these. `candidate` was
 * found in the home folder by its markers and is only reported.
 */
export type SettingsFolderOrigin = 'default' | 'variable' | 'recorded' | 'candidate';

export interface SettingsFolder {
  /** The folder, absolute. */
  path: string;
  origin: SettingsFolderOrigin;
}

/** The part of a manifest's `settingsFolder` declaration that places paths. */
export interface SettingsFolderPlacement {
  settingsFolder?: { path: string; variable: string; carries?: Record<string, string> };
}

/**
 * A manifest home path resolved for `folder`. In the default folder every path resolves where the manifest puts it;
 * in any other, including the default folder named by the variable, paths under it and carried paths move into it.
 */
export function pathInSettingsFolder(manifest: SettingsFolderPlacement, target: string, folder: SettingsFolder, homeDir?: string): string {
  const declared = manifest.settingsFolder;
  if (declared === undefined || folder.origin === 'default') return expandHome(target, homeDir);
  if (target === declared.path) return folder.path;
  if (target.startsWith(`${declared.path}/`)) return path.join(folder.path, target.slice(declared.path.length + 1));
  const carried = declared.carries?.[target];
  return carried === undefined ? expandHome(target, homeDir) : path.join(folder.path, carried);
}

/**
 * The folder a harness's variable names, as the harness reads it: an absolute value as is, a relative one against the
 * working directory of the process that reads it. A `~` is not expanded. Null when the variable is unset or blank.
 */
export function settingsVariableFolder(manifest: SettingsFolderPlacement, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const name = manifest.settingsFolder?.variable;
  const value = name === undefined ? undefined : env[name]?.trim();
  return value ? path.resolve(cwd, value) : null;
}

/**
 * Every folder beyond the default ones that a harness on this machine uses for its settings: those the provision record
 * holds and those the harnesses' variables name in this environment.
 */
export function movedSettingsFolders(mycoHome: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string[] {
  const recorded = Object.values(readProvisionRecord(mycoHome)?.settingsFolders ?? {}).flat();
  const named = BUNDLED_MANIFESTS.flatMap((manifest) => {
    const folder = settingsVariableFolder(manifest, env, cwd);
    return folder === null ? [] : [folder];
  });
  return [...new Set([...recorded, ...named])];
}
