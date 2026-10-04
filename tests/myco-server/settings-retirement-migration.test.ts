import { Database } from 'bun:sqlite';
import { describe, expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V68_RETIRED_SETTINGS } from '@myco-server-worker/db/schema-v68.js';
import { sqliteD1 } from './helpers/d1.js';
import { applySchemaSteps } from './helpers/migrate.js';

const step68 = SCHEMA_STEPS.find((step) => step.version === 68)!;
const retained = [
  ['instructions.template', '# Keep'],
] as const;
const retiredValue = (leaf: string, index: number): unknown => leaf === 'agent.provider.type' ? 'anthropic'
  : leaf === 'agent.provider.model' ? '' : leaf === 'agent.provider.base_url' ? null : { original: leaf, index };

function beforeRetirement(): Database {
  const sqlite = new Database(':memory:');
  for (const step of SCHEMA_STEPS.filter((step) => step.version < 68)) {
    for (const statement of step.statements) sqlite.exec(statement);
  }
  for (const [index, leaf] of V68_RETIRED_SETTINGS.entries()) {
    sqlite.query(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)`)
      .run(leaf, JSON.stringify(retiredValue(leaf, index)), index + 1, `mem_${index}`);
  }
  for (const [leaf, value] of retained) {
    sqlite.query(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, 100, 'mem_live')`)
      .run(leaf, JSON.stringify(value));
  }
  return sqlite;
}

function inspect(sqlite: Database) {
  const active = sqlite.query(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings ORDER BY leaf`).all();
  const archive = sqlite.query(`SELECT leaf, value, updated_at, updated_by, retired_at FROM retired_deployment_settings ORDER BY leaf`).all() as Array<{
    leaf: string; value: string; updated_at: number; updated_by: string; retired_at: number;
  }>;
  return { active, archive };
}

describe('Deployment setting retirement', () => {
  it('backs up every retired row before removal with D1 and native migration parity', async () => {
    const d1 = beforeRetirement();
    const native = beforeRetirement();
    try {
      const original = d1.query(`SELECT leaf, value, updated_at, updated_by FROM deployment_settings WHERE leaf != 'instructions.template' ORDER BY leaf`).all() as Array<{
        leaf: string; value: string; updated_at: number; updated_by: string;
      }>;
      expect(original).toHaveLength(V68_RETIRED_SETTINGS.length);
      expect(V68_RETIRED_SETTINGS).toEqual(expect.arrayContaining(['agent.provider.type', 'agent.provider.model', 'agent.provider.base_url']));

      expect(await applySchemaSteps(sqliteD1(d1), [step68])).toEqual([68]);
      native.exec('BEGIN IMMEDIATE');
      for (const statement of step68.statements) native.exec(statement);
      native.exec('COMMIT');

      const hosted = inspect(d1);
      const local = inspect(native);
      expect(hosted.archive.map(({ retired_at: _at, ...row }) => row)).toEqual(original);
      expect(local.archive.map(({ retired_at: _at, ...row }) => row)).toEqual(original);
      expect(hosted.archive.every((row) => row.retired_at > 0)).toBe(true);
      expect(local.archive.every((row) => row.retired_at > 0)).toBe(true);
      expect(hosted.active).toEqual(local.active);
      expect(hosted.active.map((row) => (row as { leaf: string }).leaf)).toEqual(retained.map(([leaf]) => leaf).sort());

      for (const statement of step68.statements) native.exec(statement);
      expect(inspect(native)).toEqual(local);
    } finally { d1.close(); native.close(); }
  });

  it('refuses to delete an original whose archive differs', async () => {
    const sqlite = beforeRetirement();
    try {
      sqlite.exec(step68.statements[0]!);
      sqlite.query(`INSERT INTO retired_deployment_settings (leaf, value, updated_at, updated_by, retired_at) VALUES (?, '"different"', 1, 'mem_0', 1)`)
        .run(V68_RETIRED_SETTINGS[0]);
      await expect(applySchemaSteps(sqliteD1(sqlite), [step68])).rejects.toThrow();
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM deployment_settings WHERE leaf IN (${V68_RETIRED_SETTINGS.map(() => '?').join(', ')})`)
        .get(...V68_RETIRED_SETTINGS)).toEqual({ n: V68_RETIRED_SETTINGS.length });
      expect(sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: '67' });
    } finally { sqlite.close(); }
  });

  it('refuses a migration that skips the archive copy', async () => {
    const sqlite = beforeRetirement();
    try {
      const missingCopy = {
        ...step68,
        statements: step68.statements.filter((statement) => !statement.startsWith('INSERT OR IGNORE INTO retired_deployment_settings')),
      };
      await expect(applySchemaSteps(sqliteD1(sqlite), [missingCopy])).rejects.toThrow();
      expect(sqlite.query(`SELECT COUNT(*) AS n FROM deployment_settings WHERE leaf = ?`).get(V68_RETIRED_SETTINGS[0]))
        .toEqual({ n: 1 });
      expect(sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`).get()).toEqual({ value: '67' });
    } finally { sqlite.close(); }
  });
});
