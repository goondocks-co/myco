/**
 * Every settings folder a harness uses on this machine. A person with several accounts for one harness keeps a folder
 * per account and selects one with the harness's own variable (`settingsFolder.variable` in its manifest). A folder is
 * found only from explicit evidence: the default folder, the variable in this environment, a direct child of the home
 * folder holding every marker the manifest declares, or a folder recorded in the provision record because the person
 * named it or provisioning set it up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '@myco/paths/home.js';
import { readProvisionRecord } from '../member/provision-record.js';
import { pathInSettingsFolder, type SettingsFolder, type SettingsFolderOrigin } from '../member/settings-folder-paths.js';
import type { SymbiontManifest, TranscriptDiscovery } from './manifest-schema.js';
import { BUNDLED_MANIFESTS } from './manifests.generated.js';

export interface SettingsFolderContext {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  /** Folders recorded for this harness, absolute. */
  recorded?: readonly string[];
}

type FolderManifest = Pick<SymbiontManifest, 'settingsFolder' | 'detectionDir' | 'configDir'>;

const homeOf = (env: NodeJS.ProcessEnv, homeDir?: string): string => homeDir ?? (env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir());

function realDirectory(folder: string): string | null {
  try {
    return fs.statSync(folder).isDirectory() ? fs.realpathSync(folder) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

function carriesMarkers(folder: string, markers: readonly string[]): boolean {
  return markers.every((marker) => fs.existsSync(path.join(folder, marker)));
}

/** The direct children of `home` that are real directories (no links) holding every marker. */
function markedHomeChildren(home: string, markers: readonly string[]): string[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(home, entry.name))
    .filter((folder) => carriesMarkers(folder, markers)).sort();
}

/**
 * The harness's settings folders, its default one first. A manifest that declares no settings folder has its default
 * one alone. The variable and recorded folders count only when they exist as directories.
 */
export function settingsFoldersOf(manifest: FolderManifest, context: SettingsFolderContext = {}): SettingsFolder[] {
  const env = context.env ?? process.env;
  const home = homeOf(env, context.homeDir);
  const declared = manifest.settingsFolder;
  const fallback = manifest.detectionDir ?? `~/${manifest.configDir}`;
  const defaultPath = expandHome(declared?.path ?? fallback, home);
  const folders: SettingsFolder[] = [{ path: defaultPath, origin: 'default' }];
  if (declared === undefined) return folders;
  const seen = new Set([realDirectory(defaultPath) ?? path.resolve(defaultPath)]);
  const add = (folder: string, origin: SettingsFolderOrigin): void => {
    const real = realDirectory(folder);
    if (real === null || seen.has(real)) return;
    seen.add(real);
    folders.push({ path: path.resolve(folder), origin });
  };
  const variable = env[declared.variable]?.trim();
  if (variable && path.isAbsolute(expandHome(variable, home))) add(expandHome(variable, home), 'variable');
  for (const folder of markedHomeChildren(home, declared.markers)) add(folder, 'home');
  for (const folder of context.recorded ?? []) if (path.isAbsolute(folder)) add(folder, 'recorded');
  return folders;
}

/** The harness's settings folders on this machine, including those recorded under `mycoHome` and any `named` now. */
export function harnessSettingsFolders(
  manifest: FolderManifest & Pick<SymbiontManifest, 'name'>, mycoHome: string, context: Omit<SettingsFolderContext, 'recorded'> & { named?: readonly string[] } = {},
): SettingsFolder[] {
  const recorded = readProvisionRecord(mycoHome)?.settingsFolders?.[manifest.name] ?? [];
  return settingsFoldersOf(manifest, { ...context, recorded: [...recorded, ...context.named ?? []] });
}

/**
 * The harness's declared transcript layout with roots in every settings folder it uses on this machine: a root under
 * its default settings folder repeats inside each other folder found.
 */
export function transcriptDiscoveryOf(
  manifest: FolderManifest & Pick<SymbiontManifest, 'name' | 'capture'>, mycoHome: string, env: NodeJS.ProcessEnv = process.env,
): TranscriptDiscovery | undefined {
  const discovery = manifest.capture?.transcriptDiscovery;
  if (discovery === undefined || manifest.settingsFolder === undefined) return discovery;
  const homeDir = homeOf(env);
  const moved = harnessSettingsFolders(manifest, mycoHome, { env, homeDir }).slice(1).flatMap((folder) => discovery.roots.flatMap((root) => {
    const inFolder = pathInSettingsFolder(manifest, root, folder, homeDir);
    return inFolder === expandHome(root, homeDir) ? [] : [inFolder];
  }));
  return moved.length === 0 ? discovery : { ...discovery, roots: [...discovery.roots, ...new Set(moved)] };
}

/** An agent's transcript layout across its settings folders, by manifest name, for a caller that enumerates history. */
export function folderTranscriptDiscovery(agent: string, mycoHome: string): TranscriptDiscovery | undefined {
  const manifest = BUNDLED_MANIFESTS.find((candidate) => candidate.name === agent);
  return manifest === undefined ? undefined : transcriptDiscoveryOf(manifest, mycoHome);
}

/** A folder as the person reads it: under the home folder with `~`. */
export function folderWords(folder: string, homeDir: string = homeOf(process.env)): string {
  return folder === homeDir ? '~' : folder.startsWith(homeDir + path.sep) ? `~${folder.slice(homeDir.length)}` : folder;
}

/** Where a folder was found, in the person's terms. */
export function folderOriginWords(folder: SettingsFolder, variable?: string): string {
  switch (folder.origin) {
    case 'default': return 'default folder';
    case 'variable': return `named by ${variable ?? 'its variable'}`;
    case 'home': return 'found in the home folder';
    case 'recorded': return 'named or set up before';
  }
}
