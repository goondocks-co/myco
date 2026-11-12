/** Native dependency paths from verified embedded artifacts or the development installation. */
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hostReleaseTarget, releaseTarget, type ReleaseTarget, type ReleaseTargetName } from '../../scripts/release-targets.mjs';
import { NativeArtifactCache } from './artifact-files.js';

const require_ = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface NativeDepsPaths {
  libsqlite: string | null;
  vec0: string;
}

let resolved: NativeDepsPaths | null = null;
/** The release target this binary was built for, when that target carries no native artifacts. */
let carriesNone: ReleaseTarget | null = null;

/**
 * A verb that needs the native SQLite artifacts, on a binary that carries none.
 *
 * Every path to the artifacts goes through {@link requireNativeDeps}, so each such verb refuses with this message
 * before it reads or writes anything, rather than failing on a missing file.
 */
class NativeArtifactsUnavailable extends Error {
  constructor(target: ReleaseTarget) {
    super(
      `Myco for ${target.label} does not carry the SQLite libraries (SQLite with extension loading, and sqlite-vec) ` +
      'that hosting a Deployment, or opening a Deployment\'s data files, needs. Nothing was changed. ' +
      'Use a Cloudflare Deployment (`myco setup --create cloudflare`), or host the server on another machine ' +
      '(macOS, Linux or Windows x64) and join it from here (`myco setup --join <address>`).',
    );
    this.name = 'NativeArtifactsUnavailable';
  }
}

/**
 * Declare that this binary carries no native artifacts (compiled-binary path).
 *
 * Called by the per-target entry of a target built without them, in place of
 * {@link registerEmbeddedNativeDeps}. Every verb but those that need the
 * artifacts runs as usual; those refuse with {@link NativeArtifactsUnavailable}.
 */
export async function registerNoNativeDeps(params: { target: ReleaseTargetName }): Promise<void> {
  const target = releaseTarget(params.target);
  if (!target || target.native) throw new Error(`${params.target} is not a release target built without native artifacts.`);
  carriesNone = target;
}

/**
 * Refuse, before anything is read or written, when this process has no native artifacts to hand a Deployment:
 * a binary built without them, or a checkout on a host whose release target carries none.
 *
 * @throws {NativeArtifactsUnavailable}
 */
export function requireNativeDeps(): void {
  if (resolved) return;
  const host = hostReleaseTarget();
  const missing = carriesNone ?? (host && !host.native ? host : null);
  if (missing) throw new NativeArtifactsUnavailable(missing);
}

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
  version: string;
}): Promise<void> {
  const cache = new NativeArtifactCache(params.version);

  const libsqlite = cache.materialize(libsqliteFilename(), new Uint8Array(await Bun.file(params.libsqliteEmbed).arrayBuffer()));
  const vec0 = cache.materialize(vec0Filename(), new Uint8Array(await Bun.file(params.vec0Embed).arrayBuffer()));

  Database.setCustomSQLite(libsqlite);
  resolved = { libsqlite, vec0 };
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
  requireNativeDeps();

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

  resolved = { libsqlite, vec0 };
  return resolved;
}

/** Get the materialized vec0 extension path. Throws {@link NativeArtifactsUnavailable} on a binary that carries none. */
export function getVec0Path(): string {
  if (!resolved) resolveDevNativeDeps();
  return resolved!.vec0;
}

/** Get the custom libsqlite3 path, if any was set. Throws {@link NativeArtifactsUnavailable} on a binary that carries none. */
export function getLibsqlitePath(): string | null {
  if (!resolved) resolveDevNativeDeps();
  return resolved!.libsqlite;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function targetKey(): string {
  const host = hostReleaseTarget();
  if (!host) throw new Error(`Unsupported platform: ${process.platform}-${process.arch}`);
  return host.name;
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
