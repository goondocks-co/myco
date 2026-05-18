/**
 * Plugin version — set at startup by the per-target compiled entry file via
 * `setPluginVersion()` (Bun embeds the package.json; see cli.<target>.ts).
 * Falls back to reading package.json for unbundled execution (tests, tsx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findCorePackageRoot } from './utils/find-package-root.js';

let cached: string | undefined;

/**
 * Register the plugin version. Called by the per-target entry after
 * importing package.json. Last call wins; idempotent.
 */
export function setPluginVersion(version: string): void {
  cached = version;
}

export function getPluginVersion(): string {
  if (cached) return cached;

  const root = findCorePackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: string };
      if (pkg.version) { cached = pkg.version; return cached; }
    } catch { /* continue */ }
  }

  cached = '0.0.0';
  return cached;
}
