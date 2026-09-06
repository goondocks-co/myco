import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';

/** macOS requires an extension-enabled SQLite library before the first connection opens. */
export function configureSqliteLibrary(): void {
  if (process.platform !== 'darwin') return;
  const library = process.env.MYCO_SQLITE_LIBRARY
    ?? ['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', '/usr/local/opt/sqlite/lib/libsqlite3.dylib'].find(existsSync);
  if (library === undefined) throw new Error('sqlite-vec requires extension-enabled SQLite: install sqlite or set MYCO_SQLITE_LIBRARY');
  try { Database.setCustomSQLite(library); }
  catch (error) { if (!String(error).includes('SQLite already loaded')) throw error; }
}
