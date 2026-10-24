import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { readBudgetStatus } from '@myco-server-worker/read/budget.js';
import { budgetStatusLine, type BudgetStatus } from '@goondocks/myco-shared/budget-status';
import { LocalVolume } from './local-volume.js';
import type { LocalDeploymentPaths } from './local.js';
import { operatorLogin, peekCommandDir, readDeploymentRecord, type CloudflareFetch } from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { d1OperatorStore } from './d1-operator-store.js';

export async function localBudgetStatus(paths: LocalDeploymentPaths,native?:NativeSqlite):Promise<BudgetStatus> {
  return new LocalVolume(paths).reading(async()=>{
    configureSqliteLibrary(native);
    const sqlite=new Database(paths.databasePath,{readonly:true});
    try { return await readBudgetStatus(sqliteRelationalStore(sqlite),Date.now()); }
    finally {sqlite.close();}
  });
}
export async function cloudflareBudgetStatus(options:LifecycleOptions & {fetch?:CloudflareFetch}):Promise<BudgetStatus> {
  const record=readDeploymentRecord(options.mycoHome);
  if (!record?.databaseId || record.accountId!==options.accountId) throw new Error('No matching recorded Deployment database');
  const login=operatorLogin({...options,configDir:peekCommandDir(options.mycoHome)});
  return readBudgetStatus(d1OperatorStore({accountId:record.accountId,databaseId:record.databaseId,login,fetch:options.fetch,report:options.report}),Date.now());
}
export async function operatorBudgetLine(read:()=>Promise<BudgetStatus>):Promise<string> {
  try { return budgetStatusLine(await read()); }
  catch(error) {return `Daily work budget unavailable: ${error instanceof Error?error.message:String(error)}`;}
}
