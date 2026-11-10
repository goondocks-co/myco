import fs from 'node:fs';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { completeBudgetMigration } from '@myco-server-worker/db/meta/budget-activation.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import type { SchemaStep } from '@myco-server-worker/db/schema-step.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';

/**
 * A populated store at the schema of the last release, made the way a Deployment reaches the next one: the Deployment
 * runs at the latest schema and its users write through its routes; their rows are carried into a store built from the
 * steps the last release shipped, which the target upgrades with every step since, as a deploy of this build would.
 */

const RELEASE_TAGS = 'myco/v*';
const MIGRATIONS_DIR = 'packages/myco-server/migrations';
const REPOSITORY = path.resolve(import.meta.dir, '..', '..');

function git(args: readonly string[]): string {
  const run = Bun.spawnSync(['git', ...args], { cwd: REPOSITORY, stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`git ${args.join(' ')} exited ${run.exitCode}: ${run.stderr.toString()}`);
  return run.stdout.toString();
}

/**
 * The schema version the last release shipped: the highest migration file in the tree of the newest release tag (by
 * creation date) whose tree holds migration files, so a maintenance tag of a line without them is passed over.
 */
function releasedSchemaVersion(): { tag: string; version: number } {
  const tags = git(['tag', '--list', RELEASE_TAGS, '--sort=-creatordate']).split('\n').map((line) => line.trim()).filter((line) => line !== '');
  if (tags.length === 0) {
    throw new Error(`no ${RELEASE_TAGS} release tag in this checkout, so the upgrade cannot start where the last release left a Deployment: fetch tags (git fetch --tags, or fetch-tags: true on actions/checkout)`);
  }
  for (const tag of tags) {
    const listed = Bun.spawnSync(['git', 'ls-tree', '--name-only', `${tag}:${MIGRATIONS_DIR}`], { cwd: REPOSITORY, stdout: 'pipe', stderr: 'pipe' });
    if (listed.exitCode !== 0) continue;
    const versions = listed.stdout.toString().split('\n')
      .map((name) => /^\d+_v(\d+)\.sql$/.exec(name.trim())?.[1]).filter((value): value is string => value !== undefined).map(Number);
    if (versions.length > 0) return { tag, version: Math.max(...versions) };
  }
  throw new Error(`no ${RELEASE_TAGS} release tag holds files under ${MIGRATIONS_DIR}: fetch the release tags of this line`);
}

/**
 * The steps a Deployment on the last release already holds, and the steps this build adds. When this build adds none
 * (or predates the tag), the latest step alone is the upgrade, so the scenario still upgrades over populated rows.
 */
export function upgradeSplit(): { released: number; previous: SchemaStep[]; upgrade: SchemaStep[] } {
  const latest = SCHEMA_STEPS.at(-1)!.version;
  const { version } = releasedSchemaVersion();
  const released = version < latest ? version : SCHEMA_STEPS.at(-2)!.version;
  return { released, previous: SCHEMA_STEPS.filter((step) => step.version <= released), upgrade: SCHEMA_STEPS.filter((step) => step.version > released) };
}

/** The migration files of `steps`. */
export function migrationFilesOf(steps: readonly SchemaStep[]): ReturnType<typeof renderMigrationFiles> {
  const versions = new Set(steps.map((step) => step.version));
  return renderMigrationFiles().filter((file) => versions.has(Number(/^\d+_v(\d+)\.sql$/.exec(file.name)?.[1])));
}

/**
 * Applies `steps` as the self-hosted migrator does: foreign keys on, one transaction per step, one statement per call,
 * so a failing statement fails its step rather than being passed over inside a multi-statement call.
 */
export function applySteps(db: Database, steps: readonly SchemaStep[], observe: { beforeStatement?(step: SchemaStep, statement: string): void } = {}): void {
  db.exec('PRAGMA foreign_keys = ON');
  for (const step of steps) {
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const statement of step.statements) {
        observe.beforeStatement?.(step, statement);
        db.run(statement);
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.inTransaction) db.exec('ROLLBACK');
      throw new Error(`schema step ${step.version} failed: ${(error as Error).message}`, { cause: error });
    }
  }
}

/** The schema objects a store holds, without the ledgers and runtime tables that are no part of Myco's schema. */
export const SCHEMA_OBJECTS_SQL = `SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name <> 'd1_migrations'
  AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY type, name`;

export type SchemaObject = { type: string; name: string; sql: string };

/** The schema objects of a fresh Deployment at the latest schema: every step, then the budget activation its boot completes. */
export async function freshSchemaObjects(): Promise<SchemaObject[]> {
  const db = new Database(':memory:');
  try {
    applySteps(db, SCHEMA_STEPS);
    const activation = await completeBudgetMigration(sqliteRelationalStore(db), Date.now());
    if (!activation.active) throw new Error(`a fresh store refused budget activation: ${activation.reason}`);
    return db.query(SCHEMA_OBJECTS_SQL).all() as SchemaObject[];
  } finally { db.close(); }
}

/** The schema objects every step declares, before anything a Deployment creates at runtime. */
export function declaredSchemaObjects(): Set<string> {
  const db = new Database(':memory:');
  try {
    applySteps(db, SCHEMA_STEPS);
    return new Set((db.query(SCHEMA_OBJECTS_SQL).all() as SchemaObject[]).map((object) => `${object.type}:${object.name}`));
  } finally { db.close(); }
}

/** The one local D1 database file under a Wrangler persist directory. */
export function localD1File(persistDir: string): string {
  const dir = path.join(persistDir, 'v3', 'd1', 'miniflare-D1DatabaseObject');
  const files = fs.readdirSync(dir).filter((name) => name.endsWith('.sqlite') && name !== 'metadata.sqlite');
  if (files.length !== 1) throw new Error(`Cloudflare parity target has ${files.length} local D1 database files`);
  return path.join(dir, files[0]!);
}
