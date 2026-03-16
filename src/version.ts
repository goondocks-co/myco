/**
 * Resolve the plugin's package version from package.json.
 * Uses the agent registry to find the plugin root, then reads package.json.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AgentRegistry } from './agents/registry.js';

let cached: string | undefined;

export function getPluginVersion(): string {
  if (cached) return cached;

  // Primary: resolve via agent env var (CLAUDE_PLUGIN_ROOT, etc.)
  const pluginRoot = new AgentRegistry().resolvePluginRoot();
  if (pluginRoot) {
    cached = readVersionFrom(pluginRoot);
    if (cached) return cached;
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
