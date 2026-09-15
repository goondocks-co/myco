/**
 * A Deployment this machine runs itself, from the binary that is already here.
 *
 * The third subtree of `~/.myco/server/` beside `compose/` and `cloudflare/`
 * (`layout.ts`), holding everything one Deployment is: its stored settings, its
 * volume, its objects, and the secrets it is sealed under.
 *
 *   local/server.json   0600  the settings a start reads
 *   local/myco.sqlite         the volume
 *   local/blobs/              content-addressed objects
 *   local/secrets.env   0600  the wrapping key and the sign-in secrets
 *
 * Secrets sit in a `0600` file beside the volume rather than inside it: the key
 * a store is sealed under does not live in the store it protects
 * (`myco-2.0.md` §3.3.1), and a single-user machine's own file is the idiom
 * this project already holds machine secrets under.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { ensureServerLayout } from './layout.js';
import { LocalVolume } from './local-volume.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';

/** What a locally-run Deployment is, as its settings file holds it. */
export interface LocalDeploymentRecord {
  /** The port the Deployment binds. */
  port: number;
  /** The address members reach it at, when something other than its own loopback fronts it. */
  origin?: string;
  /** Where the caller's address comes from: `socket` for one reached directly, `proxy` for one behind a reverse proxy. */
  sourceFrom: 'socket' | 'proxy';
  /** The header a fronting proxy sets, required when `sourceFrom` is `proxy`. */
  trustedHeader?: string;
  /** How many proxies sit in front, required to be at least 1 when `sourceFrom` is `proxy`. */
  trustedHops?: number;
  /** How many runtimes an attached worker may run at once. */
  fleet?: number;
}

export interface LocalDeploymentPaths {
  root: string;
  recordFile: string;
  databasePath: string;
  blobDir: string;
  secretsFile: string;
}

export const DEFAULT_LOCAL_PORT = 8787;

/** A record for a Deployment reached on its own machine and nothing else. */
export const DEFAULT_LOCAL_RECORD: LocalDeploymentRecord = {
  port: DEFAULT_LOCAL_PORT,
  sourceFrom: 'socket',
};

export class LocalDeploymentAbsent extends Error {}
export class LocalRecordUnreadable extends Error {}

export function resolveLocalPaths(mycoHome = resolveMycoHome()): LocalDeploymentPaths {
  ensureServerLayout(mycoHome);
  const root = path.join(mycoHome, 'server', 'local');
  return {
    root,
    recordFile: path.join(root, 'server.json'),
    databasePath: path.join(root, 'myco.sqlite'),
    blobDir: path.join(root, 'blobs'),
    secretsFile: path.join(root, 'secrets.env'),
  };
}

/** Whether this machine holds a locally-run Deployment. */
export function localDeploymentPresent(paths = resolveLocalPaths()): boolean {
  return existsSync(paths.recordFile);
}

export function readLocalRecord(paths = resolveLocalPaths()): LocalDeploymentRecord {
  if (!existsSync(paths.recordFile)) {
    throw new LocalDeploymentAbsent(`no Deployment on this machine (${paths.recordFile}). \`myco server create\` provisions one.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(paths.recordFile, 'utf8'));
  } catch (err) {
    throw new LocalRecordUnreadable(`${paths.recordFile} is not readable JSON: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new LocalRecordUnreadable(`${paths.recordFile} does not hold a Deployment's settings`);
  }
  return { ...DEFAULT_LOCAL_RECORD, ...(parsed as Partial<LocalDeploymentRecord>) };
}

export function writeLocalRecord(record: LocalDeploymentRecord, paths = resolveLocalPaths()): void {
  new LocalVolume(paths).exclusive(() => writeRecord(record, paths));
}

function writeRecord(record: LocalDeploymentRecord, paths: LocalDeploymentPaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  atomicWriteFileSync(paths.recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, durable: true });
}

/**
 * A Deployment declaring a proxy source establishes identity only with a header
 * it trusts and at least one hop. Refused when the record is written, so the
 * settings a start reads are settings that can serve.
 */
export function assertRecordServable(record: LocalDeploymentRecord): void {
  // Port 0 asks the kernel to choose, which leaves the address a member was
  // told to reach unrelated to the one bound.
  if (!Number.isInteger(record.port) || record.port < 1 || record.port > 65_535) {
    throw new Error(`port must be a whole number from 1 to 65535, and is ${JSON.stringify(record.port)}`);
  }
  if (record.sourceFrom !== 'socket' && record.sourceFrom !== 'proxy') {
    throw new Error(`sourceFrom must be 'socket' or 'proxy', and is ${JSON.stringify(record.sourceFrom)}`);
  }
  if (record.sourceFrom === 'proxy') {
    if ((record.trustedHeader ?? '') === '') {
      throw new Error("sourceFrom 'proxy' requires trustedHeader to name the header this Deployment's proxy sets");
    }
    if ((record.trustedHops ?? 1) < 1) {
      throw new Error("sourceFrom 'proxy' requires trustedHops to be at least 1");
    }
  }
  if (record.fleet !== undefined && (!Number.isInteger(record.fleet) || record.fleet < 1)) {
    throw new Error('fleet must be a whole number of runtimes, 1 or more');
  }
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** The secret names a locally-run Deployment holds, in the order the file lists them. */
export const LOCAL_SECRET_NAMES = ['SECRET_WRAP_KEY', 'SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] as const;
export type LocalSecretName = typeof LOCAL_SECRET_NAMES[number];

/** The two a Deployment generates for itself; the sign-in pair is installed later. */
const GENERATED: readonly LocalSecretName[] = ['SECRET_WRAP_KEY', 'SESSION_SECRET'];

const base64Random = (bytes: number): string => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64');

export function readLocalSecrets(paths: Pick<LocalDeploymentPaths, 'secretsFile'> = resolveLocalPaths()): Partial<Record<LocalSecretName, string>> {
  if (!existsSync(paths.secretsFile)) return {};
  const out: Partial<Record<LocalSecretName, string>> = {};
  for (const line of readFileSync(paths.secretsFile, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at < 1) continue;
    const name = trimmed.slice(0, at) as LocalSecretName;
    if ((LOCAL_SECRET_NAMES as readonly string[]).includes(name)) out[name] = trimmed.slice(at + 1);
  }
  return out;
}

export function writeLocalSecrets(values: Partial<Record<LocalSecretName, string>>, paths = resolveLocalPaths()): void {
  new LocalVolume(paths).exclusive(() => writeSecrets(values, paths));
}

export interface LocalSignInCredentials {
  clientId: string;
  clientSecret: string;
}

/** Holds a stopped volume throughout registration and installs only the sign-in pair. */
export function configureLocalSignIn<T>(
  paths: LocalDeploymentPaths,
  configure: (install: (credentials: LocalSignInCredentials) => void) => Promise<T>,
  origin?: string,
): Promise<T> {
  return new LocalVolume(paths).exclusive(async () => {
    const record = readLocalRecord(paths);
    assertRecordServable(record);
    const configuredOrigin = record.origin ?? `http://127.0.0.1:${record.port}`;
    if (origin !== undefined && new URL(origin).origin !== new URL(configuredOrigin).origin) {
      throw new Error(`sign-in URL must match the native Deployment origin ${configuredOrigin}`);
    }
    const secrets = readLocalSecrets(paths);
    if (GENERATED.some((name) => !secrets[name])) throw new Error('native Deployment storage and session keys must be configured before sign-in setup');
    let active = true;
    try {
      return await configure(({ clientId, clientSecret }) => {
        if (!active) throw new Error('native sign-in setup no longer holds the volume');
        if ([clientId, clientSecret].some((value) => !value || value.trim() !== value || /[\r\n]/.test(value))) {
          throw new Error('GitHub sign-in credentials must be nonempty single-line values');
        }
        writeSecrets({ ...secrets, GITHUB_CLIENT_ID: clientId, GITHUB_CLIENT_SECRET: clientSecret }, paths);
      });
    } finally { active = false; }
  });
}

function writeSecrets(values: Partial<Record<LocalSecretName, string>>, paths: LocalDeploymentPaths): void {
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const lines = LOCAL_SECRET_NAMES
    .filter((name) => (values[name] ?? '') !== '')
    .map((name) => `${name}=${values[name]!}`);
  atomicWriteFileSync(paths.secretsFile, `${lines.join('\n')}\n`, { mode: 0o600, durable: true });
}

/**
 * Generate what a Deployment seals its own store under, keeping anything
 * already there.
 *
 * A Deployment given no wrapping key fails on the first credential it is asked
 * to hold, which is a failure that surfaces long after provisioning. Generating
 * at create makes a fresh Deployment able to hold one from its first minute.
 */
export function ensureLocalSecrets(paths = resolveLocalPaths()): LocalSecretName[] {
  return new LocalVolume(paths).exclusive(() => ensureSecrets(paths));
}

function ensureSecrets(paths: LocalDeploymentPaths): LocalSecretName[] {
  const existing = readLocalSecrets(paths);
  const added = GENERATED.filter((name) => (existing[name] ?? '') === '');
  if (added.length === 0) return [];
  const next = { ...existing };
  for (const name of added) next[name] = base64Random(32);
  writeSecrets(next, paths);
  return added;
}

/** Remove the Deployment's directory and everything in it. */
export function removeLocalDeployment(paths = resolveLocalPaths()): void {
  new LocalVolume(paths).exclusive(() => rmSync(paths.root, { recursive: true, force: true }));
}

/** Provision configuration, credentials and schema while the volume is exclusively held. */
export function createLocalDeployment(record: LocalDeploymentRecord, native: NativeSqlite, paths = resolveLocalPaths()) {
  return new LocalVolume(paths).exclusive(() => {
    assertRecordServable(record);
    writeRecord(record, paths);
    const generated = ensureSecrets(paths);
    return { generated, applied: migrateOnly(paths.databasePath, native) };
  });
}

/** A serving process must release its volume before an operator applies migrations. */
export function updateLocalDeployment(native: NativeSqlite, paths = resolveLocalPaths()): number {
  return new LocalVolume(paths).exclusive(() => migrateOnly(paths.databasePath, native));
}
