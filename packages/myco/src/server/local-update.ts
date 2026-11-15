import { Database } from 'bun:sqlite';
import { configureSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { stampedSchemaVersion } from '@myco-server-worker/platform/bun/server-main.js';
import { thinLearningUpgradeAdmission } from '@myco-server-worker/db/thin-learning-admission.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { assertRecordServable, peekLocalPaths, readLocalRecord, updateLocalDeployment } from './local.js';
import { localServiceSpec, startLocalService, waitForLocalStop, type LocalPrepareDeps } from './local-lifecycle.js';
import { assertServiceTargetHome, statusOfService, stopService, servicePaths, UNIT_NOT_HELD } from './service.js';
import { LocalVolume } from './local-volume.js';

function admitUpdate(databasePath: string, deps: LocalPrepareDeps): number {
  configureSqliteLibrary(deps.native);
  const before = stampedSchemaVersion(databasePath, deps.native);
  if (!Number.isSafeInteger(before) || before < 0 || before > SERVER_SCHEMA_VERSION) {
    throw new Error(`native update refused before stopping: schema ${before} cannot be updated by this binary (schema ${SERVER_SCHEMA_VERSION}); update Myco first, then run myco server update --target local`);
  }
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    const admission = thinLearningUpgradeAdmission(before, SERVER_SCHEMA_VERSION, deps.log ?? console.warn);
    let step = admission.next();
    while (!step.done) step = admission.next(sqlite.query(step.value).all() as Record<string, unknown>[]);
  } finally { sqlite.close(); }
  return before;
}

/** Admit while serving, migrate while stopped, and restore only a schema the previous service can serve. */
export async function updateLocalService(home: string, deps: LocalPrepareDeps): Promise<number> {
  const spec = localServiceSpec(home, deps);
  assertServiceTargetHome(spec, deps.service);
  const paths = peekLocalPaths(home);
  const record = readLocalRecord(paths);
  assertRecordServable(record);
  const url = `http://127.0.0.1:${record.port}`;
  let before: number | undefined;
  let restore = false;
  let stopped = false;
  let applied: number;
  try {
    applied = await new LocalVolume(paths).updating(
      () => admitUpdate(paths.databasePath, deps), async (accepted) => {
        before = accepted;
        const service = statusOfService(spec, { ...deps.service, inspectMissing: true });
        if (service.installed && service.detail && !service.loaded && !service.running && service.detail !== UNIT_NOT_HELD) {
          throw new Error(service.detail);
        }
        restore = service.loaded || service.running;
        if (restore) {
          stopped = true;
          stopService(spec, deps.service);
          await waitForLocalStop(home, deps);
        }
        return updateLocalDeployment(deps.native, paths);
    });
  } catch (cause) {
    if (!stopped) throw cause;
    const reason = cause instanceof Error ? cause.message : String(cause);
    try {
      const reached = stampedSchemaVersion(paths.databasePath, deps.native);
      if (reached !== before) throw new Error(`schema advanced from ${before} to ${reached}; the previous service cannot safely serve it. Run myco server update --target local with a compatible binary, or myco server restore --target local --from <artifact> --secrets-from <file> --source-retired --yes under a fresh MYCO_HOME`);
      await startLocalService(spec, url, deps);
    } catch (recovery) {
      throw new AggregateError([cause, recovery], `native update failed (${reason}); serving could not be restored: ${recovery instanceof Error ? recovery.message : String(recovery)}`);
    }
    throw new Error(`native update failed (${reason}); the previous service is answering again. Run myco server update --target local after resolving the failure`, { cause });
  }
  if (restore) {
    try { await startLocalService(spec, url, deps); }
    catch (cause) {
      throw new Error(`native schema updated to ${SERVER_SCHEMA_VERSION}; the service did not answer: ${cause instanceof Error ? cause.message : String(cause)}. Check ${servicePaths(spec, deps.service?.platform).errLog}; run myco server status --target local, then myco server install --target local`, { cause });
    }
    deps.log?.('Deployment running again.');
  }
  return applied;
}
