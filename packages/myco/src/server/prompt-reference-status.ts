import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { PROMPT_REFERENCE_LOOKBACK_DAYS, readPromptReferenceCounts } from '@myco-server-worker/read/prompt-reference-health.js';
import { LocalVolume } from './local-volume.js';
import type { LocalDeploymentPaths } from './local.js';
import { operatorLogin, peekCommandDir, readDeploymentRecord, type CloudflareFetch } from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';
import { d1OperatorStore } from './d1-operator-store.js';

type Counts = Awaited<ReturnType<typeof readPromptReferenceCounts>>;

/** Read under shared volume ownership, including while the native Deployment serves. */
export async function localPromptReferenceCounts(paths: LocalDeploymentPaths, native?: NativeSqlite): Promise<Counts> {
  return new LocalVolume(paths).reading(async () => {
    configureSqliteLibrary(native);
    const sqlite = new Database(paths.databasePath, { readonly: true });
    try { return await readPromptReferenceCounts(sqliteRelationalStore(sqlite), Date.now()); }
    finally { sqlite.close(); }
  });
}

/** Read the hosted Deployment through its recorded database and the operator's existing login. */
export async function cloudflarePromptReferenceCounts(options: LifecycleOptions & { fetch?: CloudflareFetch }): Promise<Counts> {
  const record = readDeploymentRecord(options.mycoHome);
  if (!record?.databaseId || record.accountId !== options.accountId) throw new Error('the selected Deployment has no matching recorded database');
  const login = operatorLogin({ ...options, configDir: peekCommandDir(options.mycoHome) });
  const db = d1OperatorStore({ accountId: record.accountId, databaseId: record.databaseId, login, fetch: options.fetch, report: options.report });
  return readPromptReferenceCounts(db, Date.now());
}

/** A failed read says unavailable; it must never read as zero missing references. */
export async function promptReferenceStatusLine(read: () => Promise<Counts>): Promise<string> {
  try {
    const { total, dangling } = await read();
    const kinds = total === 0 ? '' : ` (${Object.entries(dangling).map(([kind, n]) => `${kind}=${n}`).join(', ')})`;
    return `  Prompt references (${PROMPT_REFERENCE_LOOKBACK_DAYS} days): ${total} dangling${kinds}`;
  } catch (error) {
    return `  Prompt references (${PROMPT_REFERENCE_LOOKBACK_DAYS} days): unavailable — ${error instanceof Error ? error.message : String(error)}`;
  }
}
