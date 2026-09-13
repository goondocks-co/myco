import { z } from 'zod';
import { VECTOR_INDEX_NAME } from './vector-config.js';

const resourceName = z.string().min(1).regex(/^[A-Za-z0-9_-]+$/);
const resources = z.object({
  workerName: resourceName.default('myco-server'),
  databaseName: resourceName.default('myco-server'),
  bucketName: resourceName.default('myco-server-blobs'),
  vectorIndexName: resourceName.default(VECTOR_INDEX_NAME),
  wrapKeySecretName: resourceName.default('myco-secret-wrap-key'),
});

/** Resolve resource names before provisioning or rendering a Deployment. */
export function cloudflareResources(record: z.input<typeof resources> = {}): z.output<typeof resources> {
  return resources.parse(record);
}
