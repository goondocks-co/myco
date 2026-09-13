import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import {
  downloadCloudflareBlob, ensureCommandDir, exportDatabase, queryCloudflareDatabase,
  readDeploymentRecord, type CloudflareOptions,
} from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { renderDeployConfig } from './deploy-config.js';
import { LOCAL_SECRET_NAMES } from './local.js';
import { createRecoveryBundle, type RecoveryManifest } from './recovery-bundle.js';
import { importTableDump } from './sql-dump.js';

const schemaObject = z.object({
  type: z.enum(['table', 'index', 'view', 'trigger']), name: z.string().min(1), sql: z.string().min(1),
  storage: z.enum(['table', 'virtual', 'view']).nullable(),
});
const schemaObjects = z.array(schemaObject);
const SCHEMA_QUERY = `SELECT m.type, m.name, m.sql, t.type AS storage FROM sqlite_master m
  LEFT JOIN pragma_table_list t ON t.schema = 'main' AND t.name = m.name
  WHERE m.sql IS NOT NULL AND m.name NOT GLOB 'sqlite_*' AND m.name NOT GLOB '_cf_*'
    AND m.name NOT GLOB 'd1_*' AND COALESCE(t.type, '') != 'shadow'
  ORDER BY m.type, m.name`;
const quoteIdentifier = (name: string): string => '"' + name.replaceAll('"', '""') + '"';

function configuration(mycoHome?: string) {
  const held = readDeploymentRecord(mycoHome);
  if (held === null) return null;
  const { accountId, databaseId, databaseName, bucketName, workerName, versionId, deployedAt, storeId, url, fleet } = held;
  return { accountId, databaseId, databaseName, bucketName, workerName, versionId, deployedAt, storeId, url, fleet };
}

/** Capture provider SQL and all registered R2 bytes without changing the serving Deployment. */
export async function backupCloudflareDeployment(
  options: LifecycleOptions & { destination: string },
): Promise<RecoveryManifest> {
  const record = configuration(options.mycoHome);
  if (record === null) throw new Error('No Cloudflare Deployment record exists on this machine');
  if (record.accountId !== options.accountId) throw new Error('backup account does not match the Cloudflare Deployment record');
  const config = renderDeployConfig(record);
  const bindings = z.object({ d1_databases: z.array(z.object({ binding: z.string(), database_id: z.string() })) })
    .parse(Bun.TOML.parse(config)).d1_databases.filter((binding) => binding.database_id === record.databaseId);
  if (bindings.length !== 1) throw new Error('recovery configuration must bind exactly the recorded D1 database');
  const databaseName = bindings[0]!.binding;
  const configDir = ensureCommandDir(options.mycoHome);
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
      const tables = before.filter((row) => row.storage === 'table').map((row) => row.name);
      if (before.some((row) => row.storage === 'table' && /\bAUTOINCREMENT\b/i.test(row.sql))) tables.push('sqlite_sequence');
      const virtual = before.filter((row) => row.storage === 'virtual');
      if (tables.length === 0) throw new Error('D1 holds no ordinary tables to recover');
      for (const row of virtual) {
        if (!/\bUSING\s+fts5\s*\(/i.test(row.sql) || !/\bcontent\s*=\s*'[^']+'/i.test(row.sql)) {
          throw new Error(`recovery cannot reconstruct virtual table ${row.name}`);
        }
      }
      options.report?.('Exporting D1; Cloudflare temporarily pauses queries during the snapshot');
      const { sqlPath } = await exportDatabase({ ...provider, destination: workDir, tables });
      const after = schemaObjects.parse(await queryCloudflareDatabase({ ...provider, sql: SCHEMA_QUERY }));
      if (JSON.stringify(before) !== JSON.stringify(after)
        || JSON.stringify(record) !== JSON.stringify(configuration(options.mycoHome))) {
        throw new Error('Deployment schema or configuration changed during its snapshot; retry');
      }
      const db = new Database(file, { create: true });
      try {
        db.exec('BEGIN');
        await importTableDump(db, sqlPath);
        for (const row of virtual) db.exec(row.sql);
        for (const type of ['index', 'view', 'trigger']) {
          for (const row of before.filter((item) => item.type === type)) db.exec(row.sql);
        }
        for (const row of virtual) {
          const name = quoteIdentifier(row.name);
          db.exec(`INSERT INTO ${name}(${name}) VALUES('rebuild')`);
        }
        const reconstructed = schemaObjects.parse(db.query(SCHEMA_QUERY).all());
        if (JSON.stringify(before) !== JSON.stringify(reconstructed)) throw new Error('exported database schema does not match its source');
        db.exec('COMMIT');
      } finally { db.close(); }
      return { configuration: { ...record }, credentialsRequired: [...LOCAL_SECRET_NAMES] };
    },
    blob: async (blob, workDir) => {
      const file = path.join(workDir, 'download.blob');
      fs.rmSync(file, { force: true });
      await downloadCloudflareBlob({ ...bound(workDir), bucketName: record.bucketName, key: blob.key, file });
      return Bun.file(file).stream();
    },
  }, options.report);
}
