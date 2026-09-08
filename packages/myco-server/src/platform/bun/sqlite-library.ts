import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import type { NativeSqlite } from './native.js';

/** Where a host-installed extension-enabled SQLite is found on macOS. */
const DARWIN_LIBRARIES = ['/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', '/usr/local/opt/sqlite/lib/libsqlite3.dylib'];

/**
 * Register the SQLite library extensions load from, before the first connection
 * opens.
 *
 * A deployment that names its own library uses it on every platform: an
 * artifact it carries is reachable wherever it runs, and nothing on the host
 * has to supply one. Named on macOS, this is what makes a deployment servable
 * on a machine that holds no host-installed SQLite at all.
 *
 * A deployment that names none keeps the operator's `MYCO_SQLITE_LIBRARY` and
 * then the host lookup, which macOS requires and Linux does not.
 */
export function configureSqliteLibrary(native?: NativeSqlite): void {
  const library = resolveSqliteLibrary(native);
  if (library === undefined) return;
  try { Database.setCustomSQLite(library); }
  catch (error) { if (!String(error).includes('SQLite already loaded')) throw error; }
}

/**
 * Which library a deployment would register, decided without registering it.
 *
 * Separate from the registration so the decision can be asserted: registration
 * is global to the process and answers the same way once anything has loaded,
 * which makes the choice itself unobservable through it.
 *
 * A carried artifact wins over the operator's variable, which wins over the
 * host lookup. `undefined` leaves the runtime's own library in place, which is
 * enough everywhere but macOS.
 */
export function resolveSqliteLibrary(native?: NativeSqlite): string | undefined {
  const named = native?.library ?? (process.env.MYCO_SQLITE_LIBRARY === '' ? undefined : process.env.MYCO_SQLITE_LIBRARY);
  if (named !== undefined && named !== null) return named;
  if (process.platform !== 'darwin') return undefined;
  const found = DARWIN_LIBRARIES.find(existsSync);
  if (found === undefined) {
    throw new Error('sqlite-vec requires extension-enabled SQLite: carry one with the deployment, install sqlite, or set MYCO_SQLITE_LIBRARY');
  }
  return found;
}
