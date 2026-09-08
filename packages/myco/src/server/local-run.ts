/**
 * Starting the Deployment this machine holds.
 *
 * The settings file is one source of a start's values and a container's
 * environment is the other; both land on `startDeployment`, which is the single
 * start path for this target. Everything decided here is a mapping — the
 * refusals, the binding, the drain all live in the server.
 *
 * The native artifacts and the dashboard come from the binary that is running
 * this: `runtime/native-deps.js` resolves the SQLite library and the vector
 * extension the per-target entry embedded, and the dashboard travels as a
 * generated module. A Deployment started this way locates nothing on the host.
 */
import { mkdirSync } from 'node:fs';
import {
  DEFAULT_PORT,
  migrateOnly,
  startDeployment,
  type DeploymentOptions,
  type StartedDeployment,
} from '@myco-server-worker/platform/bun/server-main.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import type { StaticAssets } from '@myco-server-worker/platform/bun/static.js';
import { getLibsqlitePath, getVec0Path } from '../runtime/native-deps.js';
import { BUNDLED_SERVER_UI } from '../server-ui-assets.generated.js';
import {
  assertRecordServable,
  readLocalRecord,
  readLocalSecrets,
  resolveLocalPaths,
  type LocalDeploymentPaths,
  type LocalDeploymentRecord,
} from './local.js';

/** The native artifacts this binary carries, as paths on disk. */
export function carriedNative(): NativeSqlite {
  return { library: getLibsqlitePath(), vec0: getVec0Path() };
}

/** The Deployment dashboard this binary carries, decoded once per process. */
let decodedShell: StaticAssets | null = null;
export function carriedDashboard(): StaticAssets {
  decodedShell ??= Object.fromEntries(
    Object.entries(BUNDLED_SERVER_UI).map(([key, value]) => [key, new Uint8Array(Buffer.from(value, 'base64'))]),
  );
  return decodedShell;
}

/**
 * The settings a start reads, from the record this machine holds.
 *
 * A Deployment reached on its own machine takes its caller's address from the
 * socket, which no caller can forge. One behind a proxy declares the header it
 * trusts, and the record is refused without it rather than serving nothing but
 * health.
 */
export function optionsFromRecord(
  record: LocalDeploymentRecord,
  paths: LocalDeploymentPaths,
  secrets: Partial<Record<string, string>> = {},
): DeploymentOptions {
  assertRecordServable(record);
  const port = record.port ?? DEFAULT_PORT;
  return {
    databasePath: paths.databasePath,
    blobDir: paths.blobDir,
    port,
    // Both loopback literals plus a Host allowlist: the host-process shape.
    transport: 'loopback',
    bind: 'loopback',
    sourceFrom: record.sourceFrom,
    header: record.trustedHeader,
    trustedHops: record.trustedHops ?? 1,
    uiAssets: carriedDashboard(),
    native: carriedNative(),
    origin: record.origin ?? `http://127.0.0.1:${port}`,
    ...(record.fleet === undefined ? {} : { fleet: record.fleet }),
    SECRET_WRAP_KEY: secrets.SECRET_WRAP_KEY,
    SESSION_SECRET: secrets.SESSION_SECRET,
    GITHUB_CLIENT_ID: secrets.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: secrets.GITHUB_CLIENT_SECRET,
  };
}

export interface LocalStart extends StartedDeployment {
  /** The record the start read. */
  record: LocalDeploymentRecord;
}

/**
 * Bring this machine's Deployment up.
 *
 * The volume is brought current first. A start against a volume the binary is
 * ahead of is refused by the server rather than migrated on the request path,
 * and a binary that replaced itself is exactly the case that leaves one behind.
 */
export async function runLocalDeployment(paths = resolveLocalPaths()): Promise<LocalStart> {
  const record = readLocalRecord(paths);
  const options = optionsFromRecord(record, paths, readLocalSecrets(paths));
  mkdirSync(paths.blobDir, { recursive: true, mode: 0o700 });
  migrateOnly(paths.databasePath, options.native);
  const started = await startDeployment(options);
  return { ...started, record };
}
