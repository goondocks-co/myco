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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { resolveMycoHome } from '../paths/home.js';
import { ensureServerLayout } from './layout.js';

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
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  writeFileSync(paths.recordFile, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  chmodSync(paths.recordFile, 0o600);
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

export function readLocalSecrets(paths = resolveLocalPaths()): Partial<Record<LocalSecretName, string>> {
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
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const lines = LOCAL_SECRET_NAMES
    .filter((name) => (values[name] ?? '') !== '')
    .map((name) => `${name}=${values[name]!}`);
  writeFileSync(paths.secretsFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  chmodSync(paths.secretsFile, 0o600);
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
  const existing = readLocalSecrets(paths);
  const added = GENERATED.filter((name) => (existing[name] ?? '') === '');
  if (added.length === 0) return [];
  const next = { ...existing };
  for (const name of added) next[name] = base64Random(32);
  writeLocalSecrets(next, paths);
  return added;
}

/** Remove the Deployment's directory and everything in it. */
export function removeLocalDeployment(paths = resolveLocalPaths()): void {
  rmSync(paths.root, { recursive: true, force: true });
}
