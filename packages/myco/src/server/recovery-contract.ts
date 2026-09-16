/**
 * The operator side of the recovery contract: the shape lives in server core, and this adds the validation that
 * parses a staging found on disk, plus the identity that binds a materialized artifact to the staging it came from.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { BLOB_KEY_GRAMMAR } from '@myco-server-worker/ingest/kinds.js';

export {
  STAGING_FORMAT, STAGING_MANIFEST_FILE, STAGING_OBJECTS_DIRECTORY, STAGING_SCHEMA_FILE, STAGING_SQL_FILE,
  type RecoveryFingerprint, type RecoveryStagingObject,
} from '@myco-server-worker/core/recovery-staging.js';
import { STAGING_FORMAT } from '@myco-server-worker/core/recovery-staging.js';

export const fingerprintSchema = z.object({ sha256: z.string().regex(BLOB_KEY_GRAMMAR), bytes: z.number().int().nonnegative() });

/** A staged object: the key the artifact stores it under, its size, and the digest its bytes must hash to. */
const stagingObjectSchema = z.object({
  key: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(BLOB_KEY_GRAMMAR),
});

export const stagingManifestSchema = z.object({
  format: z.literal(STAGING_FORMAT),
  source: z.object({ target: z.enum(['local', 'cloudflare']), locator: z.string().min(1) }),
  status: z.enum(['open', 'complete']),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().optional(),
  /** The export bytes, and the schema objects captured from the source; both are held to these fingerprints. */
  database: fingerprintSchema,
  schema: fingerprintSchema,
  exportBookmark: z.string().min(1).optional(),
  configuration: z.record(z.string(), z.unknown()),
  credentialsRequired: z.array(z.string()),
  objects: z.array(stagingObjectSchema),
}).superRefine((value, ctx) => {
  if (value.status === 'complete' && value.completedAt === undefined) ctx.addIssue({ code: 'custom', message: 'staging completion time is missing' });
  if (new Set(value.objects.map((object) => object.key)).size !== value.objects.length) {
    ctx.addIssue({ code: 'custom', message: 'staging inventory repeats an object key' });
  }
});

export type RecoveryStagingManifest = z.infer<typeof stagingManifestSchema>;

/**
 * The identity of one staged snapshot: its export and schema fingerprints, the configuration and credentials it
 * carries, its export bookmark, and its whole object inventory. Two stagings share an identity only when a
 * materialization of either would produce the same artifact, so an artifact can be bound to the one it came from.
 */
export function stagingIdentity(manifest: RecoveryStagingManifest): string {
  const canonical = JSON.stringify([
    manifest.format, manifest.source.target, manifest.source.locator,
    manifest.database.sha256, manifest.database.bytes, manifest.schema.sha256, manifest.schema.bytes,
    manifest.exportBookmark ?? null, manifest.configuration, manifest.credentialsRequired,
    [...manifest.objects].sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
      .map((object) => [object.key, object.bytes, object.sha256]),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}
