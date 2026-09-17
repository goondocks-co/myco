import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { applyMigrations, D1_STATEMENT_TIMEOUT_MS, importCloudflareDatabase, queryCloudflareDatabase, type CloudflareOptions } from './cloudflare.js';
import { RECOVERY_FINGERPRINT_KEY, writeRecoverySql } from './recovery-sql.js';

const rows = z.array(z.object({ key: z.string(), value: z.string() }));
const tables = z.array(z.object({ name: z.string() }));

/** Import into an owned empty database, or resume an import bearing the same completion fingerprint. */
export async function restoreCloudflareDatabase(options: CloudflareOptions & {
  databaseName: string; databasePath: string; sourceFingerprint: string; report?: (line: string) => void;
}): Promise<{ schemaVersion: number; imported: boolean }> {
  if (!/^[a-f0-9]{64}$/.test(options.sourceFingerprint)) throw new Error('invalid recovery source fingerprint');
  const source = new Database(options.databasePath, { readonly: true, create: false });
  let sourceVersion: number;
  try {
    sourceVersion = Number(source.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key='version'").get()?.value);
  } finally { source.close(); }
  if (!Number.isSafeInteger(sourceVersion) || sourceVersion < 1 || sourceVersion > SERVER_SCHEMA_VERSION) {
    throw new Error('recovery database has no supported schema version');
  }
  const query = (sql: string) => queryCloudflareDatabase({ ...options, sql, timeoutMs: D1_STATEMENT_TIMEOUT_MS });
  const names = tables.parse(await query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'"));
  const readIdentity = async () => {
    const metadata = rows.parse(await query(`SELECT key,value FROM schema_meta WHERE key IN ('version','${RECOVERY_FINGERPRINT_KEY}')`));
    const fingerprint = metadata.find((row) => row.key === RECOVERY_FINGERPRINT_KEY)?.value;
    const version = Number(metadata.find((row) => row.key === 'version')?.value);
    if (fingerprint !== options.sourceFingerprint) throw new Error('destination database has no matching completed recovery import; its data was not changed');
    if (!Number.isSafeInteger(version) || version < sourceVersion || version > SERVER_SCHEMA_VERSION) {
      throw new Error('destination recovery schema is outside the supported migration window');
    }
    return version;
  };
  if (names.length > 0) {
    if (!names.some((row) => row.name === 'schema_meta')) throw new Error('recovery requires an empty destination database; its data was not changed');
    await readIdentity();
  }
  const temporary = fs.mkdtempSync(path.join(options.configDir, '.recovery-import-'));
  fs.chmodSync(temporary, 0o700);
  try {
    if (names.length === 0) {
      const file = path.join(temporary, 'snapshot.sql');
      const generated = writeRecoverySql(options.databasePath, file, options.sourceFingerprint);
      options.report?.(`Importing ${generated.tables} tables and ${generated.rows} rows into the replacement database`);
      await importCloudflareDatabase({ ...options, file });
      await readIdentity();
    }
    const ledgerFile = path.join(temporary, 'ledger.sql');
    const knownNames = SCHEMA_STEPS.map(migrationFileName);
    if (names.some((row) => row.name === 'd1_migrations')) {
      const existing = tables.parse(await query('SELECT name FROM d1_migrations'));
      if (existing.some((row) => !knownNames.includes(row.name))) throw new Error('destination has an unknown migration ledger entry');
    }
    const ledger = [
      'CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT UNIQUE,applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)',
      ...SCHEMA_STEPS.filter((step) => step.version <= sourceVersion)
        .map((step) => `INSERT OR IGNORE INTO d1_migrations(name) VALUES('${migrationFileName(step)}')`),
    ];
    fs.writeFileSync(ledgerFile, ledger.join(';\n') + ';\n', { mode: 0o600 });
    await importCloudflareDatabase({ ...options, file: ledgerFile });
    await applyMigrations(options);
    const schemaVersion = await readIdentity();
    if (schemaVersion !== SERVER_SCHEMA_VERSION) throw new Error('replacement database did not reach the bundled schema version');
    return { schemaVersion, imported: names.length === 0 };
  } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
}
