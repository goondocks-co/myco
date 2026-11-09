import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { CONTEXT_PLACEMENT_STATUS_DAYS, deliveriesNotPlaced, type DeliveriesNotPlaced } from '@myco-server-worker/db/sessions/placement.js';
import { LocalVolume } from './local-volume.js';
import type { LocalDeploymentPaths } from './local.js';
import { operatorLogin, peekCommandDir, readDeploymentRecord, type CloudflareFetch } from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { d1OperatorStore } from './d1-operator-store.js';


/** Read under shared volume ownership, including while the native Deployment serves. */
export async function withLocalDiagnosticStore<T>(paths:LocalDeploymentPaths,read:(db:RelationalStore)=>Promise<T>,native?:NativeSqlite):Promise<T>{
  return new LocalVolume(paths).reading(async () => {
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readonly: true });
    try { return await read(sqliteRelationalStore(sqlite)); }
    finally { sqlite.close(); }
  });
}

/** Read the hosted Deployment through its recorded database and the operator's existing login. */
export async function withCloudflareDiagnosticStore<T>(options:LifecycleOptions & {fetch?:CloudflareFetch},read:(db:RelationalStore)=>Promise<T>):Promise<T>{
  const record = readDeploymentRecord(options.mycoHome);
  if (!record?.databaseId || record.accountId !== options.accountId) throw new Error('the selected Deployment has no matching recorded database');
  const login = operatorLogin({ ...options, configDir: peekCommandDir(options.mycoHome) });
  const db = d1OperatorStore({ accountId: record.accountId, databaseId: record.databaseId, login, fetch: options.fetch, report: options.report });
  return read(db);
}

export const localUnplacedContextRecords=(paths:LocalDeploymentPaths,native?:NativeSqlite):Promise<DeliveriesNotPlaced>=>
  withLocalDiagnosticStore(paths,db=>deliveriesNotPlaced(db,Date.now()),native);
export const cloudflareUnplacedContextRecords=(options:LifecycleOptions&{fetch?:CloudflareFetch}):Promise<DeliveriesNotPlaced>=>
  withCloudflareDiagnosticStore(options,db=>deliveriesNotPlaced(db,Date.now()));

const STATUS_LABEL = `  Context deliveries not placed on a turn (${CONTEXT_PLACEMENT_STATUS_DAYS} UTC days)`;

/** The status line: a failed read remains unavailable, deliveries not yet walked read as building, and a total names which kind each one is. */
export async function hookPlacementStatusLine(read: () => Promise<DeliveriesNotPlaced>): Promise<string> {
  try {
    const counted = await read();
    if (counted.state === 'building') return `${STATUS_LABEL}: building`;
    const total = counted.unnamed + counted.unavailable;
    return total === 0 ? `${STATUS_LABEL}: 0` : `${STATUS_LABEL}: ${total} (${counted.unnamed} named no prompt, ${counted.unavailable} named a prompt not held)`;
  } catch (error) {
    return `${STATUS_LABEL}: unavailable — ${error instanceof Error ? error.message : String(error)}`;
  }
}
