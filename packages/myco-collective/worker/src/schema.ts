const PROJECTS_TABLE = `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    worker_url TEXT NOT NULL,
    api_key_hash TEXT NOT NULL,
    capabilities TEXT DEFAULT '[]',
    package_version TEXT,
    schema_version INTEGER,
    last_seen INTEGER,
    registered_at INTEGER NOT NULL
  )`;

const SETTINGS_OVERRIDES_TABLE = `
  CREATE TABLE IF NOT EXISTS settings_overrides (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    description TEXT,
    updated_at INTEGER NOT NULL,
    updated_by TEXT
  )`;

const META_TABLE = `
  CREATE TABLE IF NOT EXISTS collective_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`;

export async function initD1Schema(db: D1Database): Promise<void> {
  const statements = [PROJECTS_TABLE, SETTINGS_OVERRIDES_TABLE, META_TABLE].map((sql) => db.prepare(sql));
  await db.batch(statements);
}
