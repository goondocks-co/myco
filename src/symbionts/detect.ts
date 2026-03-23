import { SymbiontManifestSchema, type SymbiontManifest } from './manifest-schema.js';
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

/** Load all symbiont manifests from the package's dist directory. */
export function loadManifests(): SymbiontManifest[] {
  const candidates = [
    path.resolve(import.meta.dirname, MANIFESTS_SUBDIR),
    path.resolve(import.meta.dirname, '..', MANIFESTS_SUBDIR),
    path.resolve(import.meta.dirname, '..', '..', MANIFESTS_SUBDIR),
  ];

  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.yaml'));
    if (files.length === 0) continue;
    return files.map(f => {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf-8'));
      return SymbiontManifestSchema.parse(raw);
    });
  }
  return [];
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

/** Find the Myco package root (where package.json lives). */
export function resolvePackageRoot(): string {
  let dir = import.meta.dirname;
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}
