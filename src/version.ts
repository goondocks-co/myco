/**
 * Plugin version — injected at build time by tsup define.
 * Falls back to reading package.json for unbundled execution (tests, tsx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findPackageRoot } from './utils/find-package-root.js';

declare const __MYCO_VERSION__: string;

let cached: string | undefined;

export function getPluginVersion(): string {
  if (cached) return cached;

  // Primary: build-time injected constant
  if (typeof __MYCO_VERSION__ !== 'undefined') {
    cached = __MYCO_VERSION__;
    return cached;
  }

  // Fallback: read package.json from package root (unbundled/test execution)
  const root = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  if (root) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8')) as { version?: string };
      if (pkg.version) { cached = pkg.version; return cached; }
    } catch { /* continue */ }
  }

  cached = '0.0.0';
  return cached;
}
