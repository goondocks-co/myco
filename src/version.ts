/**
 * Resolve the plugin's package version from package.json.
 * Uses the agent registry to find the plugin root, then reads package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SymbiontRegistry } from './symbionts/registry.js';

let cached: string | undefined;

export function getPluginVersion(): string {
  if (cached) return cached;

  // Primary: resolve via agent env var (CLAUDE_PLUGIN_ROOT, etc.)
  const pluginRoot = new SymbiontRegistry().resolvePluginRoot();
  if (pluginRoot) {
    cached = readVersionFrom(pluginRoot);
    if (cached) return cached;
  }

  // Secondary: walk up from this file to find package.json (works for daemon)
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const version = readVersionFrom(dir);
    if (version) {
      cached = version;
      return cached;
    }
    dir = path.dirname(dir);
  }

  // Fallback: walk up from cwd
  cached = readVersionFrom(process.cwd()) ?? '0.0.0';
  return cached;
}

function readVersionFrom(dir: string): string | undefined {
  const pkgPath = path.join(dir, 'package.json');
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
    return pkg.version;
  } catch {
    return undefined;
  }
}
