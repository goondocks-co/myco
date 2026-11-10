import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { LEDGER_ENABLED_AT } from '@myco-server-worker/db/schema-v95.js';
import { GUARD_ENABLED_AT } from '@myco-server-worker/db/schema-v101.js';
import { removeWhenTestsEnd } from '../../support/remove-when-tests-end.js';
import { DEPLOYMENT_ID_KEY } from './d1.js';

/**
 * Databases holding the current schema, copied from a template each test process builds once.
 *
 * Replaying every schema step costs seconds per database, so a test that only needs the current schema gets a private
 * copy of a database that replayed them once in this process: a deserialized image on native SQLite, and a copy of
 * Miniflare's own D1 object file on D1, which Miniflare then opens through its real D1 path. The templates are built
 * from the `SCHEMA_STEPS` this process loaded, so a changed schema is a new template on the next run. Tests about
 * migrations replay the steps they test instead.
 *
 * A replay leaves exactly four values that depend on when and where it ran: the Deployment's random id, the instants
 * the run ledger and its guard were enabled, and the instant the object store walk arms itself. Every copy draws those
 * again, with the expressions the steps use, so a copy is the database a replay at that instant would leave.
 * `schema-template.test.ts` compares copies with full replays on both stores.
 */

/** The cells a replay stamps from the clock or at random, drawn again on every copy as the steps draw them. */
export const RESTAMPED_CELLS = [
  { table: 'schema_meta', key: DEPLOYMENT_ID_KEY },
  { table: 'schema_meta', key: LEDGER_ENABLED_AT },
  { table: 'schema_meta', key: GUARD_ENABLED_AT },
  { table: 'object_store_reconciliation', column: 'armed_at' },
] as const;

const NOW_MS = `CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT)`;
const RESTAMP_SQL = [
  `UPDATE schema_meta SET value = lower(hex(randomblob(16))) WHERE key = '${DEPLOYMENT_ID_KEY}'`,
  `UPDATE schema_meta SET value = ${NOW_MS} WHERE key IN ('${LEDGER_ENABLED_AT}', '${GUARD_ENABLED_AT}')`,
  `UPDATE object_store_reconciliation SET armed_at = (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000 WHERE slot = 1`,
];

/** The schema steps every template replays, each as one batch, as `wrangler d1 migrations apply` applies them. */
export async function replaySchema(db: RelationalStore): Promise<void> {
  for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql) => db.prepare(sql)));
}

let nativeImage: Uint8Array | null = null;

/**
 * A private in-memory database holding the current schema and nothing else. Foreign key enforcement is a setting of
 * the connection, not the file: it is on unless `foreignKeys` is false, for a test that opened a bare connection.
 */
export function schemaSqlite(options: { foreignKeys?: boolean } = {}): Database {
  if (nativeImage === null) {
    const template = new Database(':memory:');
    try {
      template.exec('PRAGMA foreign_keys = ON');
      // Each step in one transaction, as the store's batch applies it.
      const apply = template.transaction((statements: readonly string[]) => { for (const sql of statements) template.exec(sql); });
      for (const step of SCHEMA_STEPS) apply(step.statements);
      nativeImage = template.serialize();
    } finally { template.close(); }
  }
  const sqlite = Database.deserialize(nativeImage);
  if (options.foreignKeys !== false) sqlite.exec('PRAGMA foreign_keys = ON');
  for (const sql of RESTAMP_SQL) sqlite.exec(sql);
  return sqlite;
}

const D1_OBJECT_DIR = path.join('d1', 'miniflare-D1DatabaseObject');
const WORKER = 'export default { fetch() { return new Response(null); } }';
const COMPATIBILITY_DATE = '2026-08-01';

function persistRoot(prefix: string): string {
  return removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

function objectFiles(root: string): string[] {
  const dir = path.join(root, D1_OBJECT_DIR);
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite') : [];
}

/** Opens D1 database `id` in a Miniflare persisting under `root`, runs `use`, and answers the object file Miniflare stored it in. */
async function persistD1(root: string, id: string, use: (db: RelationalStore) => Promise<void>): Promise<string> {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: WORKER, compatibilityDate: COMPATIBILITY_DATE,
    d1Databases: { DB: id }, resourcePersistencePath: root }));
  try { await use(await mf.getD1Database('DB') as unknown as RelationalStore); }
  finally { await mf.dispose(); }
  const [file, ...others] = objectFiles(root);
  if (file === undefined || others.length > 0) throw new Error(`expected one D1 object file under ${root}, found ${objectFiles(root).length}`);
  return file;
}

/** Folds the write-ahead log into the database file, so the file alone is the database. */
function checkpoint(file: string, statements: readonly string[] = []): void {
  const sqlite = new Database(file);
  try {
    for (const sql of statements) sqlite.exec(sql);
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { sqlite.close(); }
}

let d1Template: Promise<string> | null = null;
const objectNames = new Map<string, Promise<string>>();

/** The D1 template's object file, replayed once in this process. */
function d1TemplateFile(): Promise<string> {
  d1Template ??= (async () => {
    const root = persistRoot('myco-schema-d1-');
    const file = path.join(root, D1_OBJECT_DIR, await persistD1(root, 'myco-schema-template', replaySchema));
    checkpoint(file);
    return file;
  })();
  // A file removed when an earlier test file ended is built again, once however many callers find it gone.
  const built = d1Template;
  return built.then((file) => {
    if (fs.existsSync(file)) return file;
    if (d1Template === built) d1Template = null;
    return d1TemplateFile();
  });
}

/** The file name Miniflare stores D1 database `id` under, learnt by opening it once in an empty root. */
function objectName(id: string): Promise<string> {
  let name = objectNames.get(id);
  if (name === undefined) {
    name = (async () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-d1-name-'));
      try { return await persistD1(root, id, async (db) => { await db.prepare('SELECT 1').first(); }); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    })();
    objectNames.set(id, name);
  }
  return name;
}

/**
 * A fresh Miniflare persistence root holding, for each D1 database id in `ids`, a private database with the current
 * schema and nothing else. Pass it as `resourcePersistencePath` with the same ids bound (a plain binding list binds
 * each name as its own id); the root is removed when the tests end.
 */
export async function schemaD1Root(ids: readonly string[] = ['DB']): Promise<string> {
  const template = await d1TemplateFile();
  const root = persistRoot('myco-schema-d1-copy-');
  fs.mkdirSync(path.join(root, D1_OBJECT_DIR), { recursive: true });
  for (const id of ids) {
    const file = path.join(root, D1_OBJECT_DIR, await objectName(id));
    fs.copyFileSync(template, file);
    checkpoint(file, RESTAMP_SQL);
  }
  return root;
}
