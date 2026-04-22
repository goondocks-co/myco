/**
 * Native-dep path resolution for both dev mode and compiled binaries.
 *
 * Three native artifacts Myco needs at runtime:
 *   1. `libsqlite3` with SQLITE_ENABLE_LOAD_EXTENSION — for sqlite-vec.
 *   2. `vec0` extension — the sqlite-vec shared library.
 *   3. `rg` — the ripgrep binary for exploration-tools.
 *
 * In compiled binaries (Phase 2 wires this up), each target ships its own
 * copies embedded via `import X from './path' with { type: "file" }`. At
 * startup, `registerNativeDeps()` materializes the embedded files to a
 * version-keyed temp dir so `dlopen`/exec can read real filesystem paths.
 *
 * In dev mode (`bun run src/entries/cli.ts`), the artifacts live in
 * `node_modules` and the system package dirs. This module detects those
 * locations so dev runs work without any pre-registration.
 */

import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface NativeDepsPaths {
  libsqlite: string | null;
  vec0: string;
  ripgrep: string;
}

let resolved: NativeDepsPaths | null = null;

/**
 * Register native-dep paths from embedded artifacts (compiled-binary path).
 *
 * Called by the per-target entry files (`cli.<target>.ts`) before any
 * Database is constructed. Materializes the `/$bunfs/` embed paths to real
 * disk paths and calls `Database.setCustomSQLite()` so subsequent vector-store
 * Database instances have extension loading available.
 */
export async function registerEmbeddedNativeDeps(params: {
  libsqliteEmbed: string;
  vec0Embed: string;
  ripgrepEmbed: string;
  version: string;
}): Promise<void> {
  const cacheDir = path.join(os.tmpdir(), 'myco-runtime', params.version);
  fs.mkdirSync(cacheDir, { recursive: true });

  const libsqlite = await materialize(params.libsqliteEmbed, path.join(cacheDir, libsqliteFilename()));
  const vec0 = await materialize(params.vec0Embed, path.join(cacheDir, vec0Filename()));
  const ripgrep = await materialize(params.ripgrepEmbed, path.join(cacheDir, ripgrepFilename()));

  Database.setCustomSQLite(libsqlite);
  resolved = { libsqlite, vec0, ripgrep };
}

/**
 * Resolve native-dep paths from the dev-mode filesystem.
 *
 * Called on demand when no embedded registration has happened yet. Looks for
 * artifacts in `node_modules` and standard system locations.
 *
 * @throws if required artifacts aren't findable — dev has to install them.
 */
export function resolveDevNativeDeps(): NativeDepsPaths {
  if (resolved) return resolved;

  const libsqlite = findDevLibsqlite();
  if (libsqlite) {
    try {
      Database.setCustomSQLite(libsqlite);
    } catch (err) {
      // Under `bun test --isolate`, each test file runs with a fresh module
      // registry but shares the native SQLite library. A second call throws
      // "SQLite already loaded" — benign, since the custom library is already
      // registered from the first file that needed it.
      if (!String(err).includes('SQLite already loaded')) throw err;
    }
  }

  const vec0 = findDevVec0();
  const ripgrep = findDevRipgrep();

  resolved = { libsqlite, vec0, ripgrep };
  return resolved;
}

/** Get the materialized vec0 extension path. Throws if not registered. */
export function getVec0Path(): string {
  if (!resolved) resolveDevNativeDeps();
  return resolved!.vec0;
}

/** Get the materialized ripgrep binary path. Throws if not registered. */
export function getRipgrepPath(): string {
  if (!resolved) resolveDevNativeDeps();
  return resolved!.ripgrep;
}

/** Get the custom libsqlite3 path, if any was set. */
export function getLibsqlitePath(): string | null {
  if (!resolved) resolveDevNativeDeps();
  return resolved!.libsqlite;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function materialize(embedPath: string, targetPath: string): Promise<string> {
  if (!fs.existsSync(targetPath)) {
    await Bun.write(targetPath, Bun.file(embedPath));
    fs.chmodSync(targetPath, 0o755);
  }
  return targetPath;
}

function targetKey(): string {
  if (process.platform === 'darwin') return process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  if (process.platform === 'linux') return process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  if (process.platform === 'win32') return 'windows-x64';
  throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
}

function libsqliteFilename(): string {
  if (process.platform === 'darwin') return 'libsqlite3.dylib';
  if (process.platform === 'win32') return 'libsqlite3.dll';
  return 'libsqlite3.so';
}

function vec0Filename(): string {
  if (process.platform === 'darwin') return 'vec0.dylib';
  if (process.platform === 'win32') return 'vec0.dll';
  return 'vec0.so';
}

function ripgrepFilename(): string {
  return process.platform === 'win32' ? 'rg.exe' : 'rg';
}

function findDevLibsqlite(): string | null {
  const candidates = process.platform === 'darwin'
    ? ['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', '/usr/local/opt/sqlite/lib/libsqlite3.dylib']
    : process.platform === 'linux'
      ? ['/usr/lib/x86_64-linux-gnu/libsqlite3.so.0', '/usr/lib/aarch64-linux-gnu/libsqlite3.so.0', '/usr/lib/libsqlite3.so.0']
      : [];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findDevVec0(): string {
  const pkg = `sqlite-vec-${targetKey()}`;
  try {
    const pkgJsonPath = require_.resolve(`${pkg}/package.json`);
    return path.join(path.dirname(pkgJsonPath), vec0Filename());
  } catch (err) {
    throw new Error(
      `Cannot find ${pkg} in node_modules — install optional dependency for this platform. (${(err as Error).message})`,
    );
  }
}

function findDevRipgrep(): string {
  try {
    return (require_('@vscode/ripgrep') as { rgPath: string }).rgPath;
  } catch (err) {
    throw new Error(`Cannot resolve @vscode/ripgrep — install it. (${(err as Error).message})`);
  }
}
