import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { LEDGER_ENABLED_AT } from '@myco-server-worker/db/schema-v95.js';
import { GUARD_ENABLED_AT } from '@myco-server-worker/db/schema-v101.js';
import { SERVED_PROMPTS_COUNTED_FROM } from '@myco-server-worker/db/runs/served-prompts.js';
import { removeWhenTestsEnd } from '../../support/remove-when-tests-end.js';
import { DEPLOYMENT_ID_KEY } from './d1.js';

/**
 * Databases holding the current schema, copied from a template each test run builds once.
 *
 * Replaying every schema step costs seconds per database, so a test that only needs the current schema gets a private
 * copy of a database that replayed them once: a deserialized image on native SQLite, and a copy of Miniflare's own D1
 * object file on D1, which Miniflare then opens through its real D1 path. The first process of a run to need a template
 * builds it and leaves it in the run's temp root for the run's later processes, under a name drawn from the
 * `SCHEMA_STEPS` it replayed, so a changed schema is a new template. Tests about migrations replay the steps they test
 * instead.
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
  { table: 'schema_meta', key: SERVED_PROMPTS_COUNTED_FROM },
  { table: 'object_store_reconciliation', column: 'armed_at' },
] as const;

const NOW_MS = `CAST(CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS TEXT)`;
const RESTAMP_SQL = [
  `UPDATE schema_meta SET value = lower(hex(randomblob(16))) WHERE key = '${DEPLOYMENT_ID_KEY}'`,
  `UPDATE schema_meta SET value = ${NOW_MS} WHERE key IN ('${LEDGER_ENABLED_AT}', '${GUARD_ENABLED_AT}', '${SERVED_PROMPTS_COUNTED_FROM}')`,
  `UPDATE object_store_reconciliation SET armed_at = (CAST(strftime('%s','now') AS INTEGER) + 1) * 1000 WHERE slot = 1`,
];

const LATEST = SCHEMA_STEPS.at(-1)!.version;

/** The schema steps a template replays, through `through`, each as one batch, as `wrangler d1 migrations apply` applies them. */
export async function replaySchema(db: RelationalStore, through = LATEST): Promise<void> {
  for (const step of SCHEMA_STEPS) if (step.version <= through) await db.batch(step.statements.map((sql) => db.prepare(sql)));
}

/** Names the schema the templates hold: the same steps give the same name in every process of a run. */
const SCHEMA_KEY = createHash('sha256').update(JSON.stringify(SCHEMA_STEPS.map((step) => [step.version, step.statements]))).digest('hex').slice(0, 16);

const runImagePath = (kind: string): string | null =>
  process.env.MYCO_TEST_RUN_ROOT ? path.join(process.env.MYCO_TEST_RUN_ROOT, `myco-schema-${kind}-${SCHEMA_KEY}.sqlite`) : null;

/** A template image an earlier process of this test run left in the run's temp root, or null. The root goes when the run ends. */
function runImage(kind: string): Uint8Array | null {
  const file = runImagePath(kind);
  try { return file === null ? null : fs.readFileSync(file); } catch { return null; }
}

/** Leaves a built template image for the later processes of this run, whole or not at all. */
function keepRunImage(kind: string, image: Uint8Array): Uint8Array {
  const file = runImagePath(kind);
  if (file === null) return image;
  const partial = `${file}.${process.pid}.partial`;
  try { fs.writeFileSync(partial, image); fs.renameSync(partial, file); } catch { fs.rmSync(partial, { force: true }); }
  return image;
}

const versionImages = new Map<number, Uint8Array>();

/** Applies schema steps after `from` through `through`, each step in one transaction, as the store's batch applies it. */
function applySteps(sqlite: Database, from: number, through: number): void {
  const apply = sqlite.transaction((statements: readonly string[]) => { for (const sql of statements) sqlite.exec(sql); });
  for (const step of SCHEMA_STEPS) if (step.version > from && step.version <= through) apply(step.statements);
}

/** The serialized schema at `through`, built once and continued from the nearest lower version already built. */
function imageThrough(through: number): Uint8Array {
  const cached = versionImages.get(through) ?? runImage(`native-${through}`);
  if (cached) return versionImages.set(through, cached).get(through)!;
  let from = 0;
  let base: Uint8Array | undefined;
  for (const [version, image] of versionImages) if (version < through && version > from) { from = version; base = image; }
  const sqlite = base === undefined ? new Database(':memory:') : Database.deserialize(base);
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');
    applySteps(sqlite, from, through);
    const image = keepRunImage(`native-${through}`, sqlite.serialize());
    versionImages.set(through, image);
    return image;
  } finally { sqlite.close(); }
}

/**
 * Restamp the clock and random cells this database actually has. Older versions lack the later tables and keys.
 * Learning pause and resume rows, where present, take the unixepoch milliseconds those inserts use.
 */
function restampCopy(sqlite: Database): void {
  const names = new Set((sqlite.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((row) => row.name));
  if (names.has('schema_meta')) {
    sqlite.exec(RESTAMP_SQL[0]!);
    sqlite.exec(RESTAMP_SQL[1]!);
    sqlite.exec(`UPDATE schema_meta SET value = CAST(unixepoch()*1000 AS TEXT) WHERE key IN ('learning_paused_at', 'learning_resumed_at')`);
  }
  if (names.has('object_store_reconciliation')) sqlite.exec(RESTAMP_SQL[2]!);
}

/**
 * A private in-memory database holding the current schema, or the schema through `through`, and nothing else.
 * Each version is built once in this test run. Foreign key enforcement is a setting of the connection, not the file:
 * it is on unless `foreignKeys` is false, for a test that opened a bare connection.
 */
export function schemaSqlite(options: { foreignKeys?: boolean; through?: number } = {}): Database {
  const sqlite = Database.deserialize(imageThrough(Math.min(options.through ?? LATEST, LATEST)));
  if (options.foreignKeys !== false) sqlite.exec('PRAGMA foreign_keys = ON');
  restampCopy(sqlite);
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

/** Folds the write-ahead log into the database file, so the file alone is the database, after `change` if one is given. */
function checkpoint(file: string, change: (sqlite: Database) => void = () => {}): void {
  const sqlite = new Database(file);
  try {
    change(sqlite);
    sqlite.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally { sqlite.close(); }
}

const d1Templates = new Map<number, Promise<Uint8Array>>();
const objectNames = new Map<string, Promise<string>>();

/** The D1 template's object file holding the schema through `through`, replayed once in this test run and kept in memory, as the native images are. */
function d1TemplateImage(through = LATEST): Promise<Uint8Array> {
  const kind = `d1-${COMPATIBILITY_DATE}-${through}`;
  if (!d1Templates.has(through)) d1Templates.set(through, (async () => {
    const kept = runImage(kind);
    if (kept !== null) return kept;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-d1-'));
    try {
      const file = path.join(root, D1_OBJECT_DIR, await persistD1(root, 'myco-schema-template', (db) => replaySchema(db, through)));
      checkpoint(file);
      return keepRunImage(kind, fs.readFileSync(file));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  })());
  return d1Templates.get(through)!;
}

/**
 * The file names Miniflare stores these D1 database ids under, learnt by opening them once in one empty root.
 * A name already learnt is left as it is.
 */
async function learnObjectNames(ids: readonly string[]): Promise<void> {
  const missing = ids.filter((id) => !objectNames.has(id));
  if (missing.length === 0) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-schema-d1-name-'));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: WORKER, compatibilityDate: COMPATIBILITY_DATE,
    d1Databases: [...missing], resourcePersistencePath: root }));
  try {
    const seen = new Set(objectFiles(root));
    for (const id of missing) {
      await (await mf.getD1Database(id) as unknown as RelationalStore).prepare('SELECT 1').first();
      const created = objectFiles(root).filter((name) => !seen.has(name));
      for (const name of objectFiles(root)) seen.add(name);
      if (created.length !== 1) throw new Error(`expected one D1 object file for ${id}, found ${created.length}`);
      objectNames.set(id, Promise.resolve(created[0]!));
    }
  } finally {
    await mf.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
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
 * schema, or the schema through `through`, and nothing else. Pass it as `resourcePersistencePath` with the same ids bound (a plain binding list binds
 * each name as its own id); the root is removed when the tests end.
 */
export async function schemaD1Root(ids: readonly string[] = ['DB'], through = LATEST): Promise<string> {
  const template = await d1TemplateImage(through);
  await learnObjectNames(ids);
  const root = persistRoot('myco-schema-d1-copy-');
  fs.mkdirSync(path.join(root, D1_OBJECT_DIR), { recursive: true });
  for (const id of ids) {
    const file = path.join(root, D1_OBJECT_DIR, await objectName(id));
    fs.writeFileSync(file, template);
    checkpoint(file, restampCopy);
  }
  return root;
}

// Both templates are taken while the importing test file loads, which no test's time limit covers, so the one process
// of a run that replays them charges that to no test.
imageThrough(LATEST);
await d1TemplateImage();
