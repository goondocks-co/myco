/**
 * Where a harness's manifest home paths land when a person moves its settings folder: a path under the default
 * folder, or one the declaration carries, moves into the folder; any other path stays where the manifest puts it.
 */
import path from 'node:path';
import { expandHome } from '../paths/home.js';

/** How a folder was found: `default` is the harness's own; the rest move it. */
export type SettingsFolderOrigin = 'default' | 'variable' | 'home' | 'recorded';

export interface SettingsFolder {
  /** The folder, absolute. */
  path: string;
  origin: SettingsFolderOrigin;
}

/** The part of a manifest's `settingsFolder` declaration that places paths. */
export interface SettingsFolderPlacement {
  settingsFolder?: { path: string; carries?: Record<string, string> };
}

/** A manifest home path resolved for `folder`; every path of the default folder resolves where the manifest puts it. */
export function pathInSettingsFolder(manifest: SettingsFolderPlacement, target: string, folder: SettingsFolder, homeDir?: string): string {
  const declared = manifest.settingsFolder;
  if (declared === undefined || folder.origin === 'default') return expandHome(target, homeDir);
  if (target === declared.path) return folder.path;
  if (target.startsWith(`${declared.path}/`)) return path.join(folder.path, target.slice(declared.path.length + 1));
  const carried = declared.carries?.[target];
  return carried === undefined ? expandHome(target, homeDir) : path.join(folder.path, carried);
}
