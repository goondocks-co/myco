import { expect, it } from 'bun:test';
import { renderDeployConfig } from '@myco/server/deploy-config.js';
import type { DeploymentRecord } from '@myco/server/cloudflare.js';

const record = (suffix: string): DeploymentRecord => ({
  accountId: 'fixture-account', workerName: `myco-${suffix}`, databaseName: `db-${suffix}`,
  databaseId: `${suffix.repeat(32).slice(0, 32)}`, bucketName: `blobs-${suffix}`,
  recoveryBucketName: `recovery-${suffix}`, vectorIndexName: `vectors-${suffix}`,
  storeId: `store-${suffix}`, wrapKeySecretName: `wrap-${suffix}`,
  versionId: null, deployedAt: 'fixture',
});

interface RenderedBindings {
  d1_databases: Array<{ binding: string; database_name: string; database_id: string }>;
  r2_buckets: Array<{ binding: string; bucket_name: string }>;
  vectorize: Array<{ binding: string; index_name: string }>;
  secrets_store_secrets: Array<{ binding: string; store_id: string; secret_name: string }>;
}

const bindings = (suffix: string): RenderedBindings => Bun.TOML.parse(renderDeployConfig(record(suffix))) as unknown as RenderedBindings;

it('renders two Deployment records to distinct D1, R2, Vectorize and secret bindings', () => {
  const a = bindings('a');
  const b = bindings('b');
  expect(a.d1_databases[0].binding).toBe('MYCO_DB');
  expect(b.d1_databases[0].binding).toBe('MYCO_DB');
  for (const field of ['database_name', 'database_id'] as const) expect(a.d1_databases[0][field]).not.toBe(b.d1_databases[0][field]);
  for (const binding of ['BUCKET', 'RECOVERY_BUCKET']) {
    const one = a.r2_buckets.find((item) => item.binding === binding);
    const two = b.r2_buckets.find((item) => item.binding === binding);
    if (one === undefined || two === undefined) throw new Error(`missing R2 binding ${binding}`);
    expect(one.bucket_name).not.toBe(two.bucket_name);
  }
  expect(a.vectorize[0].binding).toBe('VECTORIZE');
  expect(b.vectorize[0].binding).toBe('VECTORIZE');
  expect(a.vectorize[0].index_name).not.toBe(b.vectorize[0].index_name);
  expect(a.secrets_store_secrets[0].binding).toBe('SECRET_WRAP_KEY');
  expect(b.secrets_store_secrets[0].binding).toBe('SECRET_WRAP_KEY');
  for (const field of ['store_id', 'secret_name'] as const) expect(a.secrets_store_secrets[0][field]).not.toBe(b.secrets_store_secrets[0][field]);
});
