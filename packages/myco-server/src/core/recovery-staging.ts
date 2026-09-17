/**
 * The shape of a `myco-recovery/3` staging: what a hosted producer writes, and what the operator's materializer
 * reads. The names and the layout live here, in the one place both targets import, while the validation that parses
 * a staging on disk stays with the reader that has zod. A staging is never a recovery artifact: it carries a SQL
 * export and the schema captured beside it, and becomes an artifact only by materializing.
 */
export const STAGING_FORMAT = 'myco-recovery/3';
export const STAGING_MANIFEST_FILE = 'recovery.json';
export const STAGING_SQL_FILE = 'd1.sql';
export const STAGING_SCHEMA_FILE = 'schema.json';
export const STAGING_OBJECTS_DIRECTORY = 'objects';

/** Size and digest of one staged file. */
export interface RecoveryFingerprint { sha256: string; bytes: number }

/** A staged object: the key an artifact stores it under, its size, and the digest its bytes must hash to. */
export interface RecoveryStagingObject { key: string; bytes: number; sha256: string }

/** What a staging records. `open` is a staging still being written, and nothing may treat it as recoverable. */
export interface RecoveryStagingManifest {
  format: typeof STAGING_FORMAT;
  /** The target that produced the staging, named by that target; the reader's schema pins the names it accepts. */
  source: { target: string; locator: string };
  status: 'open' | 'complete';
  startedAt: string;
  completedAt?: string;
  /** Present once the export is staged; an open staging may not have it yet. */
  database?: RecoveryFingerprint;
  schema: RecoveryFingerprint;
  exportBookmark?: string;
  configuration: Record<string, unknown>;
  credentialsRequired: string[];
  objects: RecoveryStagingObject[];
}

/**
 * The credentials a recovery needs from outside every artifact: the key that opens the Deployment's stored settings,
 * the owner session secret, and the sign-in pair. Artifacts name them and never hold their values; every producer
 * records this list, and a native Deployment's secrets file holds exactly these, in this order.
 */
export const RECOVERY_CREDENTIAL_NAMES = ['SECRET_WRAP_KEY', 'SESSION_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'] as const;
export type RecoveryCredentialName = typeof RECOVERY_CREDENTIAL_NAMES[number];

/** The names a hosted Deployment's recorded configuration always carries: where its data lives and what it binds. */
export const HOSTED_CONFIGURATION_NAMES = [
  'accountId', 'databaseId', 'databaseName', 'workerName', 'bucketName', 'recoveryBucketName', 'vectorIndexName', 'wrapKeySecretName',
] as const;

/**
 * A hosted Deployment's configuration as a recovery records it: resource names, the secrets store, its address and its
 * fleet. Public metadata only; no field holds a credential value.
 */
export type HostedRecoveryConfiguration = Record<typeof HOSTED_CONFIGURATION_NAMES[number], string> & {
  storeId?: string;
  url?: string;
  fleet?: number;
};

/**
 * The fleet a recorded configuration names, or null when it names none. A present value that is not a whole number of
 * runtimes, 1 or more, refuses the configuration. An absent value records no fleet and says nothing about the fleet its
 * source ran with.
 */
export function recordedFleet(configuration: Readonly<Record<string, unknown>>): number | null {
  if (!Object.hasOwn(configuration, 'fleet') || configuration.fleet === undefined) return null;
  const { fleet } = configuration;
  if (typeof fleet !== 'number' || !Number.isInteger(fleet) || fleet < 1) {
    throw new Error('recorded recovery configuration names a fleet that is not a whole number of runtimes, 1 or more');
  }
  return fleet;
}

/**
 * Reads a hosted Deployment's recorded configuration: every name present as a non-empty string, `storeId` and `url`
 * strings when present, a fleet read by `recordedFleet`, and no other field, so nothing but the public record can travel
 * in it.
 */
export function readHostedRecoveryConfiguration(value: unknown): { ok: true; configuration: HostedRecoveryConfiguration } | { ok: false; reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { ok: false, reason: 'the recovery configuration is not an object' };
  const held = value as Record<string, unknown>;
  const known = new Set<string>([...HOSTED_CONFIGURATION_NAMES, 'storeId', 'url', 'fleet']);
  const unknown = Object.keys(held).filter((key) => !known.has(key));
  if (unknown.length > 0) return { ok: false, reason: `the recovery configuration carries unrecognised fields: ${unknown.sort().join(', ')}` };
  const missing = HOSTED_CONFIGURATION_NAMES.filter((name) => typeof held[name] !== 'string' || held[name] === '');
  if (missing.length > 0) return { ok: false, reason: `the recovery configuration lacks ${missing.join(', ')}` };
  for (const name of ['storeId', 'url'] as const) {
    if (held[name] !== undefined && (typeof held[name] !== 'string' || held[name] === '')) return { ok: false, reason: `the recovery configuration's ${name} is not a name` };
  }
  let fleet: number | null;
  try { fleet = recordedFleet(held); } catch (error) { return { ok: false, reason: (error as Error).message }; }
  const configuration: HostedRecoveryConfiguration = {
    accountId: held.accountId as string, databaseId: held.databaseId as string, databaseName: held.databaseName as string,
    workerName: held.workerName as string, bucketName: held.bucketName as string, recoveryBucketName: held.recoveryBucketName as string,
    vectorIndexName: held.vectorIndexName as string, wrapKeySecretName: held.wrapKeySecretName as string,
  };
  if (held.storeId !== undefined) configuration.storeId = held.storeId as string;
  if (held.url !== undefined) configuration.url = held.url as string;
  if (fleet !== null) configuration.fleet = fleet;
  return { ok: true, configuration };
}

/** Where a staging's files live under its own prefix. */
export const stagingPath = (prefix: string, ...parts: string[]): string => [prefix.replace(/\/$/, ''), ...parts].join('/');
