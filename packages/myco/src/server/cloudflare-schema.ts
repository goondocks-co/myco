import path from 'node:path';
import { THIN_LEARNING_REMOVAL_VERSION, THIN_LEARNING_PAUSE_VERSION, thinLearningUpgradeAdmission } from '@myco-server-worker/db/thin-learning-admission.js';
import { budgetMigration,budgetCompletionMessage } from '@myco-server-worker/db/meta/budget-activation.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrationFileName } from '@myco-server-worker/db/migrate.js';
import { cloudflareSchemaVersion, currentTimeTravelBookmark, runCloudflareCommand, queryCloudflareDatabase, runCloudflareStatement, D1_STATEMENT_TIMEOUT_MS, type CloudflareOptions, type DeploymentRecord } from './cloudflare.js';
import { cloudflareOperation } from './cloudflare-operation.js';
import { applyMigrationsPaced, isD1Overload, SchemaUpdateStopped, type OverloadRetry, type PacedApply } from './cloudflare-migration-pacing.js';

interface SchemaOptions extends CloudflareOptions {
  mycoHome?: string;
  record: DeploymentRecord;
  /** The operation's durable record writer; a failure refuses all migration work. */
  persist: (record: DeploymentRecord) => void | Promise<void>;
  /** A database created by this operation, verified empty before its first migration. */
  freshDatabase?: boolean;
  report?: (line: string) => void;
  observe?: (event: { phase: 'observed' | 'applying' | 'applied' | 'failed' | 'unconfirmed'; before: number; after: number; reached?: number }) => void;
  /** Resource preparation and recovery-ledger writes run only after admission. */
  prepare?: (record: DeploymentRecord) => Promise<DeploymentRecord>;
  /** How an overloaded D1 is waited out between migration attempts. */
  overloadRetry?: OverloadRetry;
}

/** Admit and apply every hosted migration under the operator lease. */
export const applyCloudflareSchema = cloudflareOperation(async (options: SchemaOptions): Promise<DeploymentRecord> => {
  let record = options.record;
  if (options.accountId !== record.accountId) throw new Error('schema update refused: selected account does not match the deployment record');
  const database = { ...options, databaseName: record.databaseName };
  let before: number;
  try {
    before = await cloudflareSchemaVersion(database);
  } catch (error) {
    if (!isD1Overload(error)) throw error;
    throw new Error(`schema update refused: D1 database ${record.databaseName} is overloaded (code 7429) before the update started; nothing was changed. Wait a few minutes for its load to settle, then run: myco server update --target cloudflare`, { cause: error });
  }
  options.observe?.({ phase: 'observed', before, after: SERVER_SCHEMA_VERSION });
  if (before > SERVER_SCHEMA_VERSION) throw new Error(`schema update refused: D1 schema ${before} is newer than this binary's ${SERVER_SCHEMA_VERSION}`);
  if (options.freshDatabase && before !== 0) throw new Error('fresh D1 provisioning refused: the destination is not empty');
  const admitUpgrade = async (from: number) => {
    const admission = thinLearningUpgradeAdmission(from, SERVER_SCHEMA_VERSION, line => options.report?.(line));
    let admitted = admission.next();
    while (!admitted.done) admitted = admission.next(await queryCloudflareDatabase({ ...database, sql: admitted.value, timeoutMs: D1_STATEMENT_TIMEOUT_MS }) as Record<string, unknown>[]);
  };
  await admitUpgrade(before);
  const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  let restoreCommand: string | undefined;
  if (before < SERVER_SCHEMA_VERSION) {
    if (!options.freshDatabase) {
      let bookmark: string;
      try {
        bookmark = await currentTimeTravelBookmark(database);
      } catch (error) {
        throw new Error(`schema advance ${before} -> ${SERVER_SCHEMA_VERSION} refused: a current D1 Time Travel bookmark is required: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
      }
      record = { ...record, schemaUpdates: [...(record.schemaUpdates ?? []), {
        bookmark, schemaBefore: before, schemaAfter: SERVER_SCHEMA_VERSION,
        recordedAt: new Date().toISOString(), workerVersionBefore: record.versionId,
      }] };
    }
    try {
      await options.persist(record);
    } catch (error) {
      throw new Error('schema advance refused: could not durably record the D1 recovery point', { cause: error });
    }
    if (!options.freshDatabase) {
      const bookmark = record.schemaUpdates!.at(-1)!.bookmark;
      options.report?.(`D1 Time Travel bookmark recorded for schema ${before} -> ${SERVER_SCHEMA_VERSION}: ${bookmark}`);
      const config = options.configFile === undefined ? '' : ` -c ${quote(path.join(options.configDir, options.configFile))}`;
      restoreCommand = `CLOUDFLARE_ACCOUNT_ID=${quote(record.accountId)} npx --no-install wrangler d1 time-travel restore ${quote(record.databaseName)} --bookmark=${bookmark}${config}`;
      options.report?.(`Database rollback: ${restoreCommand}`);
      options.report?.('Confirm the restore prompt with y; it cancels in-flight queries and prints an undo bookmark.');
      options.report?.('Schema 83 rollback: an alpha.4 Worker on schema 83 commits prompt marks but reports marked:false, including between migration and Worker upload. Keep a schema-83-compatible Worker or restore the recorded pre-migration database bookmark with the matching Worker; restoring the bookmark also rolls back subsequent writes.');
      options.report?.(record.versionId === null
        ? 'Roll back the Worker too if its code depends on the new schema; find the prior version with `wrangler deployments list`.'
        : `Roll back the Worker too if its code depends on the new schema: myco server rollback --target cloudflare --account-id=${quote(record.accountId)} --version=${quote(record.versionId)}`);
    }
  }
  record = await options.prepare?.(record) ?? record;
  if (before < SERVER_SCHEMA_VERSION) {
    options.observe?.({ phase: 'applying', before, after: SERVER_SCHEMA_VERSION });
    const settleReached = async (reached: number) => {
      options.observe?.({ phase: reached === before ? 'failed' : 'unconfirmed', before, after: SERVER_SCHEMA_VERSION, reached });
      if (before < THIN_LEARNING_REMOVAL_VERSION && reached >= THIN_LEARNING_PAUSE_VERSION) {
        await admitUpgrade(reached);
      }
    };
    let paced: PacedApply;
    try {
      paced = await applyMigrationsPaced({
        databaseName: record.databaseName, before, target: SERVER_SCHEMA_VERSION,
        apply: () => runCloudflareCommand(options, ['d1', 'migrations', 'apply', record.databaseName, '--remote']),
        liveSchema: () => cloudflareSchemaVersion(database),
        fileAfter: (version) => {
          const step = SCHEMA_STEPS.find((candidate) => candidate.version === version + 1);
          return step === undefined ? undefined : migrationFileName(step);
        },
        ...(restoreCommand === undefined ? {} : { restoreCommand }),
        ...(options.report === undefined ? {} : { report: options.report }),
        ...(options.overloadRetry === undefined ? {} : { retry: options.overloadRetry }),
      });
    } catch (error) {
      if (error instanceof SchemaUpdateStopped && error.stop.reached !== null) await settleReached(error.stop.reached);
      throw error;
    }
    if (paced.kind === 'failed') {
      const error = paced.error;
      let reached: number;
      try {
        reached = await cloudflareSchemaVersion(database);
      } catch (probeError) {
        options.report?.(`Live schema confirmation failed: ${probeError instanceof Error ? probeError.message : String(probeError)}`);
        throw error;
      }
      if (reached !== SERVER_SCHEMA_VERSION) {
        await settleReached(reached);
        throw error;
      }
      const detail = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
      options.report?.(`D1 migration apply reported ${detail}; live schema confirmed ${reached} (target ${SERVER_SCHEMA_VERSION}); continuing to the Worker.`);
    } else if (paced.confirmed !== undefined) {
      options.report?.(`D1 migration apply reported ${paced.confirmed.detail}; live schema confirmed ${paced.confirmed.reached} (target ${SERVER_SCHEMA_VERSION}); continuing to the Worker.`);
    }
    options.observe?.({ phase: 'applied', before, after: SERVER_SCHEMA_VERSION });
    if (!options.freshDatabase) {
      record = { ...record, schemaUpdates: record.schemaUpdates!.map((entry, index, entries) =>
        index === entries.length - 1 ? { ...entry, appliedAt: new Date().toISOString() } : entry) };
      await options.persist(record);
    }
  }
  const completion = budgetMigration(Date.now());
  let next = completion.next();
  while (!next.done) {
    const step = next.value;
    const request = { ...database, sql: step.sql, timeoutMs: D1_STATEMENT_TIMEOUT_MS };
    let rows:Record<string,unknown>[];
    try {rows=step.read ? await queryCloudflareDatabase(request) as Record<string, unknown>[] : (await runCloudflareStatement(request), []);}
    catch(error) {next=completion.throw(error);continue;}
    next = completion.next(rows);
  }
  const message=budgetCompletionMessage(next.value);
  if(message!==null)options.report?.(message);
  return record;
});
