import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { resolveGroveDbPath, resolveMycoHome } from '@myco/grove/paths.js';

export interface EnsureGroveDatabaseResult {
  dbPath: string;
  schemaVersion: number;
}

export function ensureGroveDatabase(
  groveId: string,
  mycoHome = resolveMycoHome(),
): EnsureGroveDatabaseResult {
  const dbPath = resolveGroveDbPath(groveId, mycoHome);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = openDatabase(dbPath);
  try {
    createSchema(db);
    const row = db.prepare(
      'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1',
    ).get() as { version: number };
    return { dbPath, schemaVersion: row.version };
  } finally {
    db.close();
  }
}
