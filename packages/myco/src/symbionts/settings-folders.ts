/**
 * Every settings folder a harness uses on this machine. A person with several accounts for one harness keeps a folder
 * per account and selects one with the harness's own variable (`settingsFolder.variable` in its manifest).
 *
 * Myco writes only into admitted folders: the default one, the one the variable names in the environment Myco runs in,
 * and those the provision record holds because the person named them or provisioning set them up. A direct child of
 * the home folder that holds the harness's markers is a candidate: reported with the command that admits it, never
 * written to.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from '@myco/paths/home.js';
import { readProvisionRecord } from '../member/provision-record.js';
import { pathInSettingsFolder, settingsVariableFolder, type SettingsFolder } from '../member/settings-folder-paths.js';
import type { SymbiontManifest, TranscriptDiscovery } from './manifest-schema.js';
import { BUNDLED_MANIFESTS } from './manifests.generated.js';

export interface SettingsFolderContext {
  env?: NodeJS.ProcessEnv;
  /** The working directory a relative variable is read against. */
  cwd?: string;
  homeDir?: string;
  /** Folders the person names now, absolute. */
  named?: readonly string[];
}

type FolderManifest = Pick<SymbiontManifest, 'name' | 'settingsFolder' | 'detectionDir' | 'configDir'>;

const homeOf = (env: NodeJS.ProcessEnv, homeDir?: string): string => homeDir ?? (env.HOME && env.HOME.length > 0 ? env.HOME : os.homedir());

function realDirectory(folder: string): string | null {
  try {
    return fs.statSync(folder).isDirectory() ? fs.realpathSync(folder) : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

function defaultFolderOf(manifest: FolderManifest, home: string): string {
  return expandHome(manifest.settingsFolder?.path ?? manifest.detectionDir ?? `~/${manifest.configDir}`, home);
}

const recordedFolders = (manifest: FolderManifest, mycoHome: string): string[] => readProvisionRecord(mycoHome)?.settingsFolders?.[manifest.name] ?? [];

/**
 * The folders Myco writes into for this harness, its default one first: the variable's folder and the recorded and
 * named ones, each an existing directory. One of them at the default folder's place counts only when the harness
 * reads files there differently once its variable names it (`carries`), and then whether or not the default folder
 * exists yet, since provisioning creates it.
 */
export function harnessSettingsFolders(manifest: FolderManifest, mycoHome: string, context: SettingsFolderContext = {}): SettingsFolder[] {
  const env = context.env ?? process.env;
  const defaultPath = defaultFolderOf(manifest, homeOf(env, context.homeDir));
  const folders: SettingsFolder[] = [{ path: defaultPath, origin: 'default' }];
  const declared = manifest.settingsFolder;
  if (declared === undefined) return folders;
  const defaultReal = realDirectory(defaultPath) ?? path.resolve(defaultPath);
  const seen = new Set<string>();
  const add = (folder: string, origin: SettingsFolder['origin']): void => {
    const real = realDirectory(folder) ?? (path.resolve(folder) === path.resolve(defaultPath) ? defaultReal : null);
    if (real === null || seen.has(real) || (real === defaultReal && declared.carries === undefined)) return;
    seen.add(real);
    folders.push({ path: path.resolve(folder), origin });
  };
  const variable = settingsVariableFolder(manifest, env, context.cwd);
  if (variable !== null) add(variable, 'variable');
  for (const folder of [...recordedFolders(manifest, mycoHome), ...context.named ?? []]) add(folder, 'recorded');
  return folders;
}

/** Recorded folders of this harness that no longer exist as directories. */
export function missingSettingsFolders(manifest: FolderManifest, mycoHome: string): string[] {
  return recordedFolders(manifest, mycoHome).filter((folder) => realDirectory(folder) === null);
}

/** Whether `relative` exists inside `folder` as the given type, with no link anywhere along it. */
function plainEntry(folder: string, relative: string, type: 'file' | 'directory'): boolean {
  const parts = relative.split('/');
  let at = folder;
  for (const [index, part] of parts.entries()) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(at); } catch { return false; }
    if (stat.isSymbolicLink()) return false;
    const last = index === parts.length - 1;
    if (last ? (type === 'file' ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) return false;
  }
  return true;
}

/**
 * Candidate settings folders by harness name, from one read of the home folder: its direct children that are real
 * directories holding every declared marker as that type, with no link along any marker, and not already admitted.
 */
export function settingsFolderCandidates(manifests: readonly FolderManifest[], mycoHome: string, context: Omit<SettingsFolderContext, 'named'> = {}): Map<string, string[]> {
  const env = context.env ?? process.env;
  const home = homeOf(env, context.homeDir);
  const declared = manifests.filter((manifest) => manifest.settingsFolder !== undefined);
  const found = new Map<string, string[]>();
  if (declared.length === 0) return found;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return found;
    throw error;
  }
  const children = entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(home, entry.name)).sort();
  for (const manifest of declared) {
    const markers = manifest.settingsFolder!.markers;
    const admitted = new Set(harnessSettingsFolders(manifest, mycoHome, context).map((folder) => realDirectory(folder.path) ?? folder.path));
    const candidates = children.filter((folder) => !admitted.has(realDirectory(folder) ?? folder)
      && markers.files.every((marker) => plainEntry(folder, marker, 'file'))
      && markers.directories.every((marker) => plainEntry(folder, marker, 'directory')));
    if (candidates.length > 0) found.set(manifest.name, candidates);
  }
  return found;
}

/** Where a path really lands: its deepest existing ancestor resolved through every link, with the rest appended. */
function landing(target: string): string | null {
  const rest: string[] = [];
  let probe = path.resolve(target);
  for (;;) {
    try {
      fs.lstatSync(probe);
      return path.join(fs.realpathSync(probe), ...rest);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' || path.dirname(probe) === probe) return null;
      rest.unshift(path.basename(probe));
      probe = path.dirname(probe);
    }
  }
}

/** The targets that would land outside `folder` once every link along them is followed. */
export function settingsFolderEscapes(folder: string, targets: readonly string[]): string[] {
  const root = realDirectory(folder);
  if (root === null) return [...targets];
  return targets.filter((target) => {
    const lands = landing(target);
    return lands === null || (lands !== root && !lands.startsWith(root + path.sep));
  });
}

/**
 * The harness's declared transcript layout with roots in every folder Myco writes into: a root under its default
 * settings folder repeats inside each other admitted folder.
 */
export function transcriptDiscoveryOf(
  manifest: FolderManifest & Pick<SymbiontManifest, 'capture'>, mycoHome: string, env: NodeJS.ProcessEnv = process.env,
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

/** An agent's transcript layout across its admitted settings folders, by manifest name, for a caller that reads history. */
export function folderTranscriptDiscovery(agent: string, mycoHome: string): TranscriptDiscovery | undefined {
  const manifest = BUNDLED_MANIFESTS.find((candidate) => candidate.name === agent);
  return manifest === undefined ? undefined : transcriptDiscoveryOf(manifest, mycoHome);
}

/** A folder as the person reads it: under the home folder with `~`. */
export function folderWords(folder: string, homeDir: string = homeOf(process.env)): string {
  return folder === homeDir ? '~' : folder.startsWith(homeDir + path.sep) ? `~${folder.slice(homeDir.length)}` : folder;
}

/** How Myco knows of a folder, in the person's terms. */
export function folderOriginWords(folder: SettingsFolder, variable?: string): string {
  switch (folder.origin) {
    case 'default': return 'default folder';
    case 'variable': return `named by ${variable ?? 'its variable'}`;
    case 'recorded': return 'named or set up before';
    case 'candidate': return 'found in the home folder';
  }
}
