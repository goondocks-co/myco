import { z } from 'zod';
import type { HostedRecoveryConfiguration } from '@myco-server-worker/core/recovery-staging.js';
import { VECTOR_INDEX_NAME } from './vector-config.js';

/** The bucket a Deployment whose record names none has always used. */
const DEFAULT_BUCKET = 'myco-server-blobs';
const resourceName = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const resources = z.object({
  workerName: resourceName.default('myco-server'),
  databaseName: resourceName.default('myco-server'),
  bucketName: resourceName.optional(),
  recoveryBucketName: resourceName.optional(),
  vectorIndexName: resourceName.default(VECTOR_INDEX_NAME),
  wrapKeySecretName: resourceName.default('myco-secret-wrap-key'),
});

/**
 * Resolve resource names before provisioning or rendering a Deployment. A record that names a bucket keeps it. A
 * bucket and a staging store are otherwise named after the Worker they belong to, so two Deployments of different names
 * never share a store; the default Worker name resolves to the bucket it always has, and a Deployment that already has
 * a database and names no bucket stays on that bucket too.
 */
export function cloudflareResources(
  record: z.input<typeof resources> & { databaseId?: string } = {},
): z.output<typeof resources> & { bucketName: string; recoveryBucketName: string } {
  const parsed = resources.parse(record);
  return {
    ...parsed,
    bucketName: parsed.bucketName ?? (record.databaseId === undefined ? `${parsed.workerName}-blobs` : DEFAULT_BUCKET),
    recoveryBucketName: parsed.recoveryBucketName ?? `${parsed.workerName}-recovery`,
  };
}

/**
 * The public configuration a recovery records for a hosted Deployment, from its deployment record: the resolved resource
 * names this Deployment binds, its secrets store, address and fleet. The operator's backup records it, and the deploy
 * config renders it for the Deployment's own producer, so both producers record the same thing.
 */
export function recoveryConfigurationOf(record: z.input<typeof resources> & {
  accountId: string; databaseId?: string; storeId?: string; url?: string; fleet?: number;
}): HostedRecoveryConfiguration {
  if (record.databaseId === undefined || record.databaseId === '') throw new Error('the deployment record names no database id to record');
  const resolved = cloudflareResources(record);
  return {
    accountId: record.accountId, databaseId: record.databaseId,
    databaseName: resolved.databaseName, workerName: resolved.workerName, bucketName: resolved.bucketName,
    recoveryBucketName: resolved.recoveryBucketName, vectorIndexName: resolved.vectorIndexName, wrapKeySecretName: resolved.wrapKeySecretName,
    ...(record.storeId === undefined || record.storeId === '' ? {} : { storeId: record.storeId }),
    ...(record.url === undefined ? {} : { url: record.url }),
    ...(record.fleet === undefined ? {} : { fleet: record.fleet }),
  };
}
