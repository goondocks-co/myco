import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import {
  cloudflareBlobReader, ensureCommandDir, exportDatabase, queryCloudflareDatabase, runCloudflareStatement,
  readDeploymentRecord, type CloudflareOptions, type CloudflareFetch, type DeploymentRecord,
} from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { renderDeployConfig } from './deploy-config.js';
import { RECOVERY_CREDENTIAL_NAMES } from '@myco-server-worker/core/recovery-staging.js';
import { recoveryHoldOf, recoveryHoldSql } from '@myco-server-worker/core/object-release.js';
import { recoveryConfigurationOf } from './cloudflare-resources.js';
import { createRecoveryBundle, type RecoveryHoldOwner, type RecoveryHoldReading, type RecoveryManifest } from './recovery-bundle.js';
import { assertRecoverableSchema, buildSnapshotDatabase, exportedTables } from './recovery-snapshot.js';
import { schemaObjects, SCHEMA_QUERY } from './recovery-schema.js';

/** What a backup records about a Deployment from its record: the recovery configuration it resolves to, and the version it runs. */
function recordedConfiguration(record: DeploymentRecord) {
  return { ...recoveryConfigurationOf(record), versionId: record.versionId, deployedAt: record.deployedAt };
}

/**
 * The recovery hold a hosted backup takes on the Deployment it is copying.
 *
 * The statements are the server's own hold owner, rendered by `recoveryHoldSql` and sent through the operator's
 * existing Wrangler D1 path; this adapter is transport, not a second lifecycle. Each is idempotent by token, so an
 * answer the provider loses is settled by reading the hold back. One read answers the hold and the Deployment that
 * holds it together, so a hold is never paired with an identity read separately. The hold is the Deployment's own row,
 * so it outlives this process: an interrupted backup resumes under it, and an abandoned one is released explicitly.
 */
function cloudflareRecoveryHold(provider: CloudflareOptions & { databaseName: string }, record: DeploymentRecord): RecoveryHoldOwner {
  const reading = async (token: string): Promise<RecoveryHoldReading> => {
    const rows = z.array(z.object({
      holder: z.string().nullable(), acquired_at: z.number().nullable(), released_at: z.number().nullable(),
      release_reason: z.string().nullable(), deployment_id: z.string().nullable(), schema_version: z.string().nullable(),
    })).parse(await queryCloudflareDatabase({ ...provider, sql: recoveryHoldSql.reading(token) }));
    const { hold, sourceIdentity } = recoveryHoldOf(token, rows[0] ?? null);
    return {
      state: hold === null ? 'absent' : hold.holder !== 'operator' ? 'other-holder' : hold.releasedAt === null ? 'open' : 'released',
      sourceIdentity,
    };
  };
  return {
    locator: `${record.accountId}/${record.databaseId}`,
    acquire: async (token) => {
      await runCloudflareStatement({ ...provider, sql: recoveryHoldSql.acquire(token, Date.now(), 'operator') });
      return reading(token);
    },
    inspect: reading,
    open: async () => {
      const rows = z.array(z.object({ token: z.string(), acquired_at: z.number() }))
        .parse(await queryCloudflareDatabase({ ...provider, sql: recoveryHoldSql.open('operator') }));
      return rows.length === 0 ? null : { token: rows[0]!.token, acquiredAt: rows[0]!.acquired_at };
    },
    release: async (token, reason) => {
      await runCloudflareStatement({ ...provider, sql: recoveryHoldSql.releaseOperator(token, Date.now(), reason) });
      return reading(token);
    },
  };
}

/**
 * The recovery hold owner of the recorded hosted Deployment, for the commands that inspect or give up a hold without
 * capturing anything.
 */
export function cloudflareRecoveryHoldOf(options: LifecycleOptions & { fetch?: CloudflareFetch }): RecoveryHoldOwner {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare Deployment record exists on this machine');
  if (record.accountId !== options.accountId) throw new Error('this account does not match the Cloudflare Deployment record');
  const configDir = ensureCommandDir(options.mycoHome);
  const config = renderDeployConfig(record);
  const configFile = path.join(configDir, 'wrangler.recovery-hold.toml');
  fs.writeFileSync(configFile, config, { mode: 0o600 });
  const databaseName = z.object({ d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() })) })
    .parse(Bun.TOML.parse(config)).d1_databases.filter((binding) => binding.database_id === record.databaseId)[0]?.binding;
  if (databaseName === undefined) throw new Error('recovery configuration must bind exactly the recorded D1 database');
  return cloudflareRecoveryHold({ ...options, configDir, configFile, databaseName }, record);
}

/** Capture provider SQL and all registered R2 bytes without changing the serving Deployment. */
export async function backupCloudflareDeployment(
  options: LifecycleOptions & { destination: string; fetch?: CloudflareFetch },
): Promise<RecoveryManifest> {
  const record = readDeploymentRecord(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare Deployment record exists on this machine');
  if (record.accountId !== options.accountId) throw new Error('backup account does not match the Cloudflare Deployment record');
  // One capture of the record names the export, renders its config and is what the artifact records.
  const config = renderDeployConfig(record);
  const recorded = recordedConfiguration(record);
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
  // The hold's statements run before any snapshot work directory exists, so its configuration is staged beside this
  // machine's own Cloudflare state, with the same rendered bindings the snapshot uses.
  const holdConfigFile = path.join(configDir, 'wrangler.recovery-hold.toml');
  fs.writeFileSync(holdConfigFile, config, { mode: 0o600 });
  return createRecoveryBundle(options.destination, {
    source,
    hold: cloudflareRecoveryHold({ ...options, configDir, configFile: holdConfigFile, databaseName }, record),
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
        || JSON.stringify(record) !== JSON.stringify(readDeploymentRecord(options.mycoHome))) {
        throw new Error('Deployment schema or configuration changed during its snapshot; retry');
      }
      await buildSnapshotDatabase(file, sqlPath, before);
      return { configuration: { ...recorded }, credentialsRequired: [...RECOVERY_CREDENTIAL_NAMES] };
    },
    blob: async (blob) => readBlob(blob.source),
  }, options.report);
}
