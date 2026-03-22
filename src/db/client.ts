/**
 * PGlite client — connection lifecycle management.
 *
 * Provides init/get/close for a singleton PGlite instance backed by
 * pgvector. The instance is created via the async factory `PGlite.create()`
 * and reused for the lifetime of the process.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import path from 'node:path';

const NOT_INITIALIZED_MSG = 'Database not initialized — call initDatabase() first';

/** Standard subdirectory name for PGlite data within a vault. */
export const PGLITE_DATA_DIR = 'pgdata';

/** Singleton PGlite instance. */
let instance: PGlite | null = null;

/**
 * Initialize (or return existing) PGlite instance with pgvector enabled.
 *
 * @param dataDir — filesystem path for persistent storage. Omit for in-memory.
 * @returns the PGlite instance.
 */
export async function initDatabase(dataDir?: string): Promise<PGlite> {
  if (instance) return instance;

  instance = await PGlite.create({
    ...(dataDir ? { dataDir } : {}),
    extensions: { vector },
  });

  await instance.query('CREATE EXTENSION IF NOT EXISTS vector');

  return instance;
}

/**
 * Return the current PGlite instance.
 *
 * @throws if `initDatabase()` has not been called.
 */
export function getDatabase(): PGlite {
  if (!instance) throw new Error(NOT_INITIALIZED_MSG);
  return instance;
}

/**
 * Close the PGlite instance and reset the singleton.
 *
 * Safe to call when already closed or never initialized.
 */
export async function closeDatabase(): Promise<void> {
  if (!instance) return;
  await instance.close();
  instance = null;
}

/**
 * Initialize PGlite for a vault directory and create the schema.
 *
 * Convenience wrapper that combines `initDatabase()` + `createSchema()` with
 * the standard `PGLITE_DATA_DIR` subdirectory. Eliminates the two-step pattern
 * and the 'pgdata' magic string at every call site.
 */
export async function initDatabaseForVault(vaultDir: string): Promise<PGlite> {
  // Lazy import to avoid circular dependency (schema.ts imports from PGlite types)
  const { createSchema } = await import('./schema.js');
  const db = await initDatabase(path.join(vaultDir, PGLITE_DATA_DIR));
  await createSchema(db);
  return db;
}
