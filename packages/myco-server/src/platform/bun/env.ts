/**
 * The self-hosted adapter: a SQLite file and a mounted volume in, `ServerEnv` out.
 *
 * This file and its siblings are the ONLY place the self-hosted server may name a
 * filesystem path or a container primitive.
 */
import type { Database } from 'bun:sqlite';
import type { BlobFailureClassifier, OwnerBindings, PlatformDescriptor, ServerEnv } from '../../core/adapters.js';
import { classifySqliteError, sqliteRelationalStore } from './sqlite.js';
import { diskBlobStore, DIGEST_MISMATCH_MESSAGE } from './blobs.js';
import { inProcessRateLimiter } from './limiter.js';
import { wrappingKeyFromText } from '../wrapping-key.js';

export const SOURCE_LIMIT = { limit: 600, periodMs: 60_000 };
export const TOKEN_LIMIT = { limit: 300, periodMs: 60_000 };

/** What a self-hosted deployment requires, named as its operator would name it in Compose. */
export const REQUIRED_BINDINGS = ['MYCO_DATABASE', 'MYCO_BLOB_DIR'] as const;

export interface BunServerConfig extends OwnerBindings {
  /** The open SQLite database on the mounted volume. */
  sqlite: Database;
  /** Directory on the mounted volume holding content-addressed blobs. */
  blobDir: string;
  /** Base64 key that Deployment secrets are sealed under; supplied from the environment, never from the store it protects. */
  SECRET_WRAP_KEY?: string;
  now?: () => number;
}

/** This store reports a digest rejection in its own words; nothing else does. */
export const classifyBlobFailureOf: BlobFailureClassifier = (message) =>
  message.includes(DIGEST_MISMATCH_MESSAGE) ? 'digest' : null;

export function bunPlatform(config: BunServerConfig): PlatformDescriptor {
  // Usability, not merely presence: an open handle that cannot answer a trivial
  // query is as missing as no handle at all, and is the shape a detached volume
  // or a half-applied migration actually takes.
  const storeUsable = (): boolean => {
    try {
      if (config.sqlite === undefined || config.sqlite === null) return false;
      config.sqlite.query('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  };

  return {
    name: 'bun',
    capabilities: () => [
      { capability: 'relational-store', label: 'Project storage', present: storeUsable(), operatorNames: ['MYCO_DATABASE'] },
      { capability: 'blob-store', label: 'Blob storage', present: Boolean(config.blobDir), operatorNames: ['MYCO_BLOB_DIR'] },
      {
        capability: 'rate-limiting',
        label: 'Request rate limiting',
        // In-process here, so there is nothing for an operator to configure and
        // nothing that can be absent. Reporting a missing binding for it would
        // be false on this target.
        present: true,
        operatorNames: [],
      },
    ],
    classifyError: classifySqliteError,
    classifyBlobFailure: classifyBlobFailureOf,
  };
}

export function serverEnvFromBunConfig(config: BunServerConfig): ServerEnv {
  const now = config.now ?? (() => Date.now());
  return {
    secrets: {
      OWNER_GITHUB_ID: config.OWNER_GITHUB_ID,
      GITHUB_CLIENT_ID: config.GITHUB_CLIENT_ID,
      GITHUB_CLIENT_SECRET: config.GITHUB_CLIENT_SECRET,
      SESSION_SECRET: config.SESSION_SECRET,
    },
    platform: bunPlatform(config),
    // Self-hosted holds the key the way this project already holds machine
    // secrets: an env value outside the store it protects.
    wrappingKey: wrappingKeyFromText(async () => config.SECRET_WRAP_KEY, 'SECRET_WRAP_KEY'),
    db: sqliteRelationalStore(config.sqlite),
    blobs: diskBlobStore(config.blobDir),
    sourceLimit: inProcessRateLimiter({ ...SOURCE_LIMIT, now }),
    tokenLimit: inProcessRateLimiter({ ...TOKEN_LIMIT, now }),
  };
}
