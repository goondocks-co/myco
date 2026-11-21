import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeWhenTestsEnd } from '../../support/remove-when-tests-end.js';
import { schemaSqlite } from './schema-template.js';

/** A new on-disk database copied from the schema template or supplied seed, which this helper closes. Foreign keys are enforced. */
export function schemaFile(file: string, copy = schemaSqlite()): Database {
  try { fs.writeFileSync(file, copy.serialize(), { flag: 'wx' }); } finally { copy.close(); }
  const sqlite = new Database(file);
  sqlite.exec('PRAGMA foreign_keys = ON');
  return sqlite;
}

/** A private native volume, removed when its tests end, with the current schema or an empty database. */
export function deploymentVolume({ migrated = true }: { migrated?: boolean } = {}): { databasePath: string; blobDir: string } {
  const root = removeWhenTestsEnd(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deployment-')));
  const databasePath = path.join(root, 'myco.sqlite');
  const sqlite = migrated ? schemaFile(databasePath) : new Database(databasePath);
  sqlite.close();
  return { databasePath, blobDir: path.join(root, 'blobs') };
}
