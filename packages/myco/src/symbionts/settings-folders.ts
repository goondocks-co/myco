/**
 * Every settings folder a harness uses on this machine. A person with several accounts for one harness keeps a folder
 * per account and selects one with the harness's own variable (`settingsFolder.variable` in its manifest).
 *
 * Myco sets up, as it does the default folder: the folder the variable names in the environment Myco runs in, a
 * direct child of the home folder that holds every marker the manifest declares as a real entry of that type (no link
 * along it), and the folders the provision record holds because the person named them or provisioning set them up.
 * A scanned folder the person retired is excluded until they name it again. A child that holds the markers but fails
 * a check is reported with the reason, never written to.
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

type FolderManifest = Pick<SymbiontManifest, 'name' | 'settingsFolder' | 'detectionDir' | 'configDir' | 'registration'>;

/** A direct child of the home folder that holds a harness's markers but fails a check, with the reason. */
export interface RejectedSettingsFolder { folder: string; reason: string }

interface HomeScan { found: string[]; rejected: RejectedSettingsFolder[] }

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

/** Why `relative` is not a real entry of the given type inside `folder` with no link along it, or null when it is. */
function markerProblem(folder: string, relative: string, type: 'file' | 'directory'): string | null {
  const parts = relative.split('/');
  let at = folder;
  for (const [index, part] of parts.entries()) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(at); } catch { return `${relative} is missing`; }
    if (stat.isSymbolicLink()) return `${relative} is a link`;
    const last = index === parts.length - 1;
    if (last ? (type === 'file' ? !stat.isFile() : !stat.isDirectory()) : !stat.isDirectory()) return `${relative} is not a ${last ? type : 'directory'}`;
  }
  return null;
}

let snapshot: Map<string, HomeScan> | null = null;

/** Run `fn` with one read of the home folder per harness shared by every lookup inside it. */
export function withSettingsFolderSnapshot<T>(fn: () => T): T {
  if (snapshot !== null) return fn();
  snapshot = new Map();
  try { return fn(); } finally { snapshot = null; }
}

/** The direct children of the home folder that hold this harness's markers: those that pass every check, and those that fail one. */
function scanHome(manifest: FolderManifest, home: string): HomeScan {
  const key = `${home}\0${manifest.name}`;
  const held = snapshot?.get(key);
  if (held !== undefined) return held;
  const scan: HomeScan = { found: [], rejected: [] };
  const markers = manifest.settingsFolder?.markers;
  let entries: fs.Dirent[] = [];
  if (markers !== undefined) {
    try { entries = fs.readdirSync(home, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const declared = markers === undefined ? [] : [...markers.files.map(marker => [marker, 'file'] as const), ...markers.directories.map(marker => [marker, 'directory'] as const)];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const folder = path.join(home, entry.name);
    if (!declared.every(([marker]) => fs.existsSync(path.join(folder, marker)))) continue;
    const problem = declared.map(([marker, type]) => markerProblem(folder, marker, type)).find((reason) => reason !== null)
      ?? heldTargetEscapes(manifest, { path: folder, origin: 'home' }, home).map((target) => `${path.relative(folder, target) || target} leads outside it`)[0];
    if (problem === undefined) scan.found.push(folder);
    else scan.rejected.push({ folder, reason: problem });
  }
  snapshot?.set(key, scan);
  return scan;
}

/**
 * The folders Myco sets up for this harness, its default one first, each an existing directory: the variable's
 * folder, the scanned folders the person has not retired, and the recorded and named ones. One of them at the default
 * folder's place counts only when the harness reads files there differently once its variable names it (`carries`),
 * and then whether or not the default folder exists yet, since provisioning creates it.
 */
export function harnessSettingsFolders(manifest: FolderManifest, mycoHome: string, context: SettingsFolderContext = {}): SettingsFolder[] {
  const env = context.env ?? process.env;
  const home = homeOf(env, context.homeDir);
  const defaultPath = defaultFolderOf(manifest, home);
  const folders: SettingsFolder[] = [{ path: defaultPath, origin: 'default' }];
  const declared = manifest.settingsFolder;
  if (declared === undefined) return folders;
  const record = readProvisionRecord(mycoHome);
  const excluded = new Set(record?.excludedSettingsFolders?.[manifest.name] ?? []);
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
  for (const folder of scanHome(manifest, home).found) if (!excluded.has(folder) || context.named?.includes(folder)) add(folder, 'home');
  for (const folder of [...record?.settingsFolders?.[manifest.name] ?? [], ...context.named ?? []]) add(folder, 'recorded');
  return folders;
}

/** Recorded folders of this harness that no longer exist as directories. */
export function missingSettingsFolders(manifest: FolderManifest, mycoHome: string): string[] {
  return (readProvisionRecord(mycoHome)?.settingsFolders?.[manifest.name] ?? []).filter((folder) => realDirectory(folder) === null);
}

/** Direct children of the home folder that hold this harness's markers but fail a check, with the reason. */
export function rejectedSettingsFolders(manifest: FolderManifest, context: Omit<SettingsFolderContext, 'named'> = {}): RejectedSettingsFolder[] {
  return manifest.settingsFolder === undefined ? [] : scanHome(manifest, homeOf(context.env ?? process.env, context.homeDir)).rejected;
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
 * The global targets a folder other than the default one holds for this harness (hooks, settings, skills, tools)
 * that would land outside it through a link. Targets the manifest keeps outside every folder are not the folder's.
 */
export function heldTargetEscapes(manifest: FolderManifest, folder: SettingsFolder, homeDir?: string): string[] {
  const reg = manifest.registration;
  if (folder.origin === 'default' || !reg) return [];
  const declared = [reg.globalHooksTarget, reg.globalSettingsTarget, reg.globalSkillsTarget, ...(reg.globalMcpTarget ?? []).map((entry) => entry.path)]
    .filter((target): target is string => typeof target === 'string');
  const held = [...new Set(declared.map((target) => pathInSettingsFolder(manifest, target, folder, homeDir)).filter((target, index) => target !== expandHome(declared[index]!, homeDir)))];
  return settingsFolderEscapes(folder.path, held);
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
    case 'home': return 'found in the home folder';
    case 'recorded': return 'named or set up before';
  }
}
