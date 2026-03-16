/**
 * Ensures native npm dependencies (better-sqlite3, sqlite-vec) are available.
 *
 * When the plugin is installed from npm via the marketplace, only the bundled
 * JS files are present in the cache directory — node_modules is stripped.
 * Native modules cannot be bundled by tsup/esbuild, so we install them on
 * first use into the plugin's cache directory.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import fs from 'node:fs';

const NATIVE_PACKAGES = ['better-sqlite3', 'sqlite-vec'] as const;

/** Detect the plugin root — either CLAUDE_PLUGIN_ROOT or walk up from this file. */
function findPluginRoot(): string {
  if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
  // Walk up from dist/src/ to find package.json
  let dir = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 5; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export function ensureNativeDeps(): void {
  const pluginRoot = findPluginRoot();
  const require = createRequire(path.join(pluginRoot, 'node_modules', '.package.json'));

  const missing: string[] = [];
  for (const pkg of NATIVE_PACKAGES) {
    try {
      require.resolve(pkg);
    } catch {
      missing.push(pkg);
    }
  }

  if (missing.length === 0) return;

  const nodeModulesDir = path.join(pluginRoot, 'node_modules');
  if (!fs.existsSync(nodeModulesDir)) {
    fs.mkdirSync(nodeModulesDir, { recursive: true });
  }

  try {
    execFileSync('npm', ['install', '--no-save', '--no-package-lock', ...missing], {
      cwd: pluginRoot,
      stdio: 'pipe',
      timeout: 120_000,
    });
  } catch (error) {
    const msg = (error as Error).message;
    process.stderr.write(`[myco] Failed to install native dependencies: ${msg}\n`);
    process.stderr.write(`[myco] You can install them manually: cd ${pluginRoot} && npm install ${missing.join(' ')}\n`);
  }
}
