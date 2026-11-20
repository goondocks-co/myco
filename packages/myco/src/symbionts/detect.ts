import { SymbiontManifestSchema, type SymbiontManifest } from './manifest-schema.js';
import { BUNDLED_MANIFESTS } from './manifests.generated.js';
import { findCorePackageRoot } from '../utils/find-package-root.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { expandHome, resolveMycoHome } from '@myco/paths/home.js';
import { harnessSettingsFolders } from './settings-folders.js';

const MANIFESTS_SUBDIR = 'symbionts/manifests';

/** Cached manifests — static files that never change at runtime. */
let manifestCache: SymbiontManifest[] | null = null;

/**
 * Load all symbiont manifests.
 *
 * Under Bun-compiled binaries the manifest YAMLs live inside the /$bunfs/
 * virtual filesystem where `fs.readdirSync` can't enumerate them. The
 * codegen-emitted `BUNDLED_MANIFESTS` array is the authoritative source in
 * that case and also when running from source (since it's regenerated on
 * every build via `npm run codegen`). We still try the filesystem first for
 * dev-mode edits that haven't been codegen'd, but the bundled array is the
 * reliable fallback that always works.
 */
export function loadManifests(): SymbiontManifest[] {
  if (manifestCache) return manifestCache;
  const candidates = [
    // Source layout: src/symbionts/detect.ts → src/symbionts/manifests/
    path.resolve(import.meta.dirname, MANIFESTS_SUBDIR),
    // Dist layout: dist/src/symbionts/ → dist/src/symbionts/manifests/
    path.resolve(import.meta.dirname, '..', MANIFESTS_SUBDIR),
    path.resolve(import.meta.dirname, '..', '..', MANIFESTS_SUBDIR),
    // Chunk layout: dist/chunk-*.js → dist/src/symbionts/manifests/
    path.resolve(import.meta.dirname, 'src', MANIFESTS_SUBDIR),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    // Inside /$bunfs/ the dir may exist but readdirSync returns empty;
    // fall through to the bundled fallback in that case.
    let files: string[] = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
    } catch { /* bundled FS can throw — fall through */ }
    if (files.length === 0) continue;
    manifestCache = byName(files.map((f) => {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      return SymbiontManifestSchema.parse(raw);
    }));
    return manifestCache;
  }

  // Fallback: codegen-emitted bundled manifests. Always works in compiled
  // binaries and is fast enough to use as the primary source if dev-mode FS
  // reads stop working for some reason.
  manifestCache = byName(BUNDLED_MANIFESTS.map((m) => SymbiontManifestSchema.parse(m)));
  return manifestCache;
}

/**
 * One manifest order on every host. `fs.readdirSync` order is
 * filesystem-defined — sorted on APFS, hash-ordered on ext4 — and the bundled
 * fallback carries codegen's emission order. Sorting by name pins what a
 * caller that indexes into the array sees to the same manifest on every
 * machine and every checkout.
 */
function byName(manifests: SymbiontManifest[]): SymbiontManifest[] {
  return [...manifests].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Installed agents use their declared directory or another settings folder of theirs, or executable and installation locations. */
export function detectMachineInstalledSymbionts(): SymbiontManifest[] {
  return loadManifests().filter(m => m.detectionDir === null ? false : m.detectionDir
    ? installedDirectory(m.detectionDir) || movedSettingsFolderFound(m)
    : hasSymbiontInstallation(m));
}

function movedSettingsFolderFound(manifest: SymbiontManifest): boolean {
  // As for the declared directory, a folder that cannot be read is not detected.
  try {
    const mycoHome = resolveMycoHome();
    return harnessSettingsFolders(manifest, mycoHome).length > 1;
  } catch { return false; }
}

function installedDirectory(location: string): boolean {
  // Any failure to read the location means "not detected": one unreadable or looping entry never stops setup for the other agents.
  try { return fs.statSync(expandHome(location)).isDirectory(); }
  catch { return false; }
}

/** Configuration managed by Myco is not installation evidence unless the manifest declares it. */
export function hasSymbiontInstallation(manifest: SymbiontManifest, binaryFound = isBinaryOnPath): boolean {
  return binaryFound(manifest.binary) || (manifest.health?.installLocations ?? []).some(location => fs.existsSync(expandHome(location)));
}

/**
 * The PATH-lookup program for a platform. `which` is POSIX-only; Windows ships
 * `where`. Both exit 0 (printing the matching path(s)) when the binary is on
 * PATH and non-zero when it isn't, so the exit-code contract is identical
 * across platforms — only the program name differs.
 */
export function pathLookupProgram(platform: NodeJS.Platform = process.platform): 'where' | 'which' {
  return platform === 'win32' ? 'where' : 'which';
}

/** Check if a binary is available on PATH. */
export function isBinaryOnPath(binary: string): boolean {
  try {
    execFileSync(pathLookupProgram(), [binary], { stdio: 'pipe', env: { ...process.env } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Find the Myco package root (where package.json lives).
 *
 * Resolution order:
 *   1. `import.meta.dirname` — works in dev mode and the legacy tsup layout.
 *   2. `fs.realpathSync(process.execPath)` — needed for the Bun-compiled
 *      binary, whose import.meta is a /$bunfs/ virtual path. The binary
 *      sits at `<pkg-root>/vendor/<target>/myco`, so its real-path parent
 *      chain reaches the package root.
 *   3. `process.cwd()` as last-resort fallback. Avoid when possible — cwd
 *      can be any directory the user happens to be in, which led to a
 *      stale-template bug when the monorepo root carried a pre-split
 *      `dist/` that shadowed the real package.
 */
export function resolvePackageRoot(): string {
  // Symbiont templates ship in @goondocks/myco core only.
  const fromImportMeta = findCorePackageRoot(import.meta.dirname);
  if (fromImportMeta) return fromImportMeta;

  try {
    const fromExec = findCorePackageRoot(path.dirname(fs.realpathSync(process.execPath)));
    if (fromExec) return fromExec;
  } catch { /* ignore */ }

  return process.cwd();
}
