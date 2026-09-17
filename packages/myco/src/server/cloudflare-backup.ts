import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  cloudflareBlobReader, ensureCommandDir, exportDatabase, queryCloudflareDatabase,
  readDeploymentRecord, type CloudflareOptions, type CloudflareFetch,
} from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { renderDeployConfig } from './deploy-config.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import { recoveryConfigurationOf } from './cloudflare-resources.js';
import { createRecoveryBundle, type RecoveryManifest } from './recovery-bundle.js';
import { assertRecoverableSchema, buildSnapshotDatabase, exportedTables } from './recovery-snapshot.js';
import { schemaObjects, SCHEMA_QUERY } from './recovery-schema.js';

/** What a backup records about the Deployment: the recovery configuration its record resolves to, and the version it runs. */
function recordedConfiguration(mycoHome?: string) {
  const held = readDeploymentRecord(mycoHome);
  return held === null ? null : { ...recoveryConfigurationOf(held), versionId: held.versionId, deployedAt: held.deployedAt };
}

/** Capture provider SQL and all registered R2 bytes without changing the serving Deployment. */
export async function backupCloudflareDeployment(
  options: LifecycleOptions & { destination: string; fetch?: CloudflareFetch },
): Promise<RecoveryManifest> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare Deployment record exists on this machine');
  if (record.accountId !== options.accountId) throw new Error('backup account does not match the Cloudflare Deployment record');
  const config = renderDeployConfig(record);
  const recorded = recordedConfiguration(options.mycoHome)!;
  const bindings = z.object({ d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() })) })
    .parse(Bun.TOML.parse(config)).d1_databases.filter((binding) => binding.database_id === record.databaseId);
  if (bindings.length !== 1) throw new Error('recovery configuration must bind exactly the recorded D1 database');
  const databaseName = bindings[0]!.binding;
  const configDir = ensureCommandDir(options.mycoHome);
  const readBlob = cloudflareBlobReader({ ...options, configDir, bucketName: record.bucketName });
  const source = { target: 'cloudflare' as const, locator: `${record.accountId}/${record.databaseId}/${record.bucketName}` };
  const bound = (workDir: string): CloudflareOptions => {
    const configFile = path.join(workDir, 'wrangler.recovery.toml');
    fs.writeFileSync(configFile, config, { mode: 0o600 });
    return { ...options, configDir, configFile };
  };
  return createRecoveryBundle(options.destination, {
    source,
    snapshot: async (file, workDir) => {
      const provider = { ...bound(workDir), databaseName };
      const before = schemaObjects.parse(await queryCloudflareDatabase({ ...provider, sql: SCHEMA_QUERY }));
      const tables = exportedTables(before);
      if (tables.length === 0) throw new Error('D1 holds no ordinary tables to recover');
      assertRecoverableSchema(before);
      options.report?.('Exporting D1; Cloudflare temporarily pauses queries during the snapshot');
      const { sqlPath } = await exportDatabase({ ...provider, destination: workDir, tables });
      const after = schemaObjects.parse(await queryCloudflareDatabase({ ...provider, sql: SCHEMA_QUERY }));
      if (JSON.stringify(before) !== JSON.stringify(after)
        || JSON.stringify(recorded) !== JSON.stringify(recordedConfiguration(options.mycoHome))) {
        throw new Error('Deployment schema or configuration changed during its snapshot; retry');
      }
      await buildSnapshotDatabase(file, sqlPath, before);
      return { configuration: { ...recorded }, credentialsRequired: [...RECOVERY_CREDENTIAL_NAMES] };
    },
    blob: async (blob) => readBlob(blob.source),
  }, options.report);
}
