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

/** Where a staging's files live under its own prefix. */
export const stagingPath = (prefix: string, ...parts: string[]): string => [prefix.replace(/\/$/, ''), ...parts].join('/');
