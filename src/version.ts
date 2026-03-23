/**
 * Plugin version — injected at build time by tsup define.
 * Falls back to reading package.json for unbundled execution (tests, tsx).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

declare const __MYCO_VERSION__: string;

const VERSION_WALK_LIMIT = 5;
let cached: string | undefined;

export function getPluginVersion(): string {
  if (cached) return cached;

  // Primary: build-time injected constant
  if (typeof __MYCO_VERSION__ !== 'undefined') {
    cached = __MYCO_VERSION__;
    return cached;
  }

  // Fallback: walk up from this file (unbundled/test execution)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < VERSION_WALK_LIMIT; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8')) as { version?: string };
      if (pkg.version) { cached = pkg.version; return cached; }
    } catch { /* continue */ }
    dir = path.dirname(dir);
  }

  cached = '0.0.0';
  return cached;
}
