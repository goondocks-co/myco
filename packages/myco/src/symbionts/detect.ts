import { SymbiontManifestSchema, type SymbiontManifest } from './manifest-schema.js';
import { BUNDLED_MANIFESTS } from './manifests.generated.js';
import { findPackageRoot } from '../utils/find-package-root.js';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export interface DetectedSymbiont {
  manifest: SymbiontManifest;
  binaryFound: boolean;
  configDirFound: boolean;
}

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
    manifestCache = files.map((f) => {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      return SymbiontManifestSchema.parse(raw);
    });
    return manifestCache;
  }

  // Fallback: codegen-emitted bundled manifests. Always works in compiled
  // binaries and is fast enough to use as the primary source if dev-mode FS
  // reads stop working for some reason.
  manifestCache = BUNDLED_MANIFESTS.map((m) => SymbiontManifestSchema.parse(m));
  return manifestCache;
}

/** Find a loaded manifest by symbiont name, or undefined. */
export function getManifestByName(name: string | undefined): SymbiontManifest | undefined {
  if (!name) return undefined;
  return loadManifests().find((m) => m.name === name);
}

/** Check if a binary is available on PATH. */
function isBinaryOnPath(binary: string): boolean {
  try {
    execFileSync('which', [binary], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/** Detect which symbionts are available for a project. */
export function detectSymbionts(projectRoot: string): DetectedSymbiont[] {
  const manifests = loadManifests();
  return manifests.map(manifest => ({
    manifest,
    binaryFound: isBinaryOnPath(manifest.binary),
    configDirFound: fs.existsSync(path.join(projectRoot, manifest.configDir)),
  })).filter(d => d.binaryFound || d.configDirFound);
}

/**
 * Find the Myco package root (where package.json lives).
 *
 * Resolution order:
 *   1. `import.meta.dirname` — works in dev mode and the old tsup layout.
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
  const fromImportMeta = findPackageRoot(import.meta.dirname);
  if (fromImportMeta) return fromImportMeta;

  try {
    const fromExec = findPackageRoot(path.dirname(fs.realpathSync(process.execPath)));
    if (fromExec) return fromExec;
  } catch { /* ignore */ }

  return process.cwd();
}
