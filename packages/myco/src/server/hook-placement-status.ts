import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { countUnplacedContextRecords, HOOK_STATUS_WINDOW_DAYS } from '@myco-server-worker/read/hook-placement.js';
import { LocalVolume } from './local-volume.js';
import type { LocalDeploymentPaths } from './local.js';
import { operatorLogin, peekCommandDir, readDeploymentRecord, type CloudflareFetch } from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { d1OperatorStore } from './d1-operator-store.js';

type Counts = number;

/** Read under shared volume ownership, including while the native Deployment serves. */
export async function localUnplacedContextRecords(paths: LocalDeploymentPaths, native?: NativeSqlite): Promise<Counts> {
  return new LocalVolume(paths).reading(async () => {
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readonly: true });
    try { return await countUnplacedContextRecords(sqliteRelationalStore(sqlite)); }
    finally { sqlite.close(); }
  });
}

/** Read the hosted Deployment through its recorded database and the operator's existing login. */
export async function cloudflareUnplacedContextRecords(options: LifecycleOptions & { fetch?: CloudflareFetch }): Promise<Counts> {
  const record = readDeploymentRecord(options.mycoHome);
  if (!record?.databaseId || record.accountId !== options.accountId) throw new Error('the selected Deployment has no matching recorded database');
  const login = operatorLogin({ ...options, configDir: peekCommandDir(options.mycoHome) });
  const db = d1OperatorStore({ accountId: record.accountId, databaseId: record.databaseId, login, fetch: options.fetch, report: options.report });
  return countUnplacedContextRecords(db);
}

/** A failed read remains unavailable. */
export async function hookPlacementStatusLine(read: () => Promise<Counts>): Promise<string> {
  try {
    return `  Context deliveries not placed on a turn (${HOOK_STATUS_WINDOW_DAYS} days): ${await read()}`;
  } catch (error) {
    return `  Context deliveries not placed on a turn (${HOOK_STATUS_WINDOW_DAYS} days): unavailable — ${error instanceof Error ? error.message : String(error)}`;
  }
}
