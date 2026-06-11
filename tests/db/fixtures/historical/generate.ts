#!/usr/bin/env bun
/**
 * Fixture generator for historical fresh-vault schemas (authoring-time only).
 *
 * Checks out an era commit into a temp worktree, runs that era's
 * `createSchema()` against a scratch SQLite file, and dumps the resulting
 * DDL (tables, indexes, triggers, views) from sqlite_master into a committed
 * JSON fixture consumed by the migration-matrix test.
 *
 * Usage: bun tests/db/fixtures/historical/generate.ts <version> <commit> [schemaModulePath]
 *   schemaModulePath defaults to packages/myco/src/db/schema.js (relative to
 *   the era worktree root).
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

function run(cmd: string[], cwd?: string): string {
  const proc = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  if (proc.exitCode !== 0) {
    throw new Error(`command failed (${proc.exitCode}): ${cmd.join(' ')}\n${proc.stderr.toString()}`);
  }
  return proc.stdout.toString();
}

const [versionArg, commitArg, schemaModuleArg] = process.argv.slice(2);
if (!versionArg || !commitArg) {
  console.error('usage: bun generate.ts <version> <commit> [schemaModulePath]');
  process.exit(1);
}
const version = Number(versionArg);
const schemaModule = schemaModuleArg ?? './packages/myco/src/db/schema.js';

const commit = run(['git', 'rev-parse', commitArg], FIXTURE_DIR).trim();
const subject = run(['git', 'log', '-1', '--format=%s', commit], FIXTURE_DIR).trim();

const worktreeDir = `/tmp/myco-hunt/rc1-fixtures/v${version}`;
mkdirSync('/tmp/myco-hunt/rc1-fixtures', { recursive: true });
if (existsSync(worktreeDir)) {
  run(['git', 'worktree', 'remove', '--force', worktreeDir], FIXTURE_DIR);
}

run(['git', 'worktree', 'add', '--detach', worktreeDir, commit], FIXTURE_DIR);
try {
  // Dump script runs inside the era worktree so bun resolves the era's
  // tsconfig path aliases (e.g. @myco/*) against the era source tree.
  const dumpScript = `
import { Database } from 'bun:sqlite';
import { createSchema } from '${schemaModule}';

const db = new Database(process.argv[2]);
createSchema(db as any);

type MasterRow = { name: string; sql: string };
const rows = (type: string): MasterRow[] =>
  db.prepare(
    "SELECT name, sql FROM sqlite_master WHERE type = ? AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid",
  ).all(type) as MasterRow[];

// FTS5 virtual tables are kept; their auto-created shadow tables
// (<fts>_data/_idx/_content/_docsize/_config) are excluded because
// CREATE VIRTUAL TABLE recreates them.
const tables = rows('table');
const virtualNames = tables
  .filter((r) => /^CREATE VIRTUAL TABLE/i.test(r.sql))
  .map((r) => r.name);
const shadow = new Set(
  virtualNames.flatMap((n) =>
    ['data', 'idx', 'content', 'docsize', 'config'].map((s) => n + '_' + s),
  ),
);

const statements = [
  ...tables.filter((r) => !shadow.has(r.name)).map((r) => r.sql),
  ...rows('index').map((r) => r.sql),
  ...rows('trigger').map((r) => r.sql),
  ...rows('view').map((r) => r.sql),
];

const stamped = db.prepare('SELECT MAX(version) AS v FROM schema_version').get() as { v: number };
console.log(JSON.stringify({ version: stamped.v, statements }));
`;
  const dumpPath = join(worktreeDir, 'dump-schema.ts');
  writeFileSync(dumpPath, dumpScript);

  const scratchDb = join(worktreeDir, 'scratch-schema.sqlite');
  const output = run(['bun', dumpPath, scratchDb], worktreeDir);
  const dump = JSON.parse(output) as { version: number; statements: string[] };

  if (dump.version !== version) {
    throw new Error(`stamped version ${dump.version} does not match requested ${version}`);
  }

  // Sanity check: the DDL alone must rebuild a loadable schema.
  const check = new Database(':memory:');
  for (const stmt of dump.statements) check.exec(stmt);
  const tableCount = (
    check.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { n: number }
  ).n;
  if (tableCount <= 10) throw new Error(`suspiciously few tables (${tableCount})`);
  const hasVersionTable = check.prepare(
    "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'",
  ).get();
  if (!hasVersionTable) throw new Error('schema_version table missing from dump');
  check.exec(`INSERT INTO schema_version (version, applied_at) VALUES (${version}, 0)`);
  check.close();

  const fixture = {
    version,
    commit,
    subject,
    generated_with: 'generate.ts',
    statements: dump.statements,
  };
  const outPath = join(FIXTURE_DIR, `v${version}.json`);
  writeFileSync(outPath, JSON.stringify(fixture, null, 2) + '\n');
  console.log(`wrote ${outPath} (${dump.statements.length} statements, ${tableCount} tables)`);
} finally {
  run(['git', 'worktree', 'remove', '--force', worktreeDir], FIXTURE_DIR);
  run(['git', 'worktree', 'prune'], FIXTURE_DIR);
}
