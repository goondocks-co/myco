import path from 'node:path';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { cloudflareSchemaVersion, currentTimeTravelBookmark, runCloudflareCommand, type CloudflareOptions, type DeploymentRecord } from './cloudflare.js';
import { cloudflareOperation } from './cloudflare-operation.js';

interface SchemaOptions extends CloudflareOptions {
  mycoHome?: string;
  record: DeploymentRecord;
  /** The operation's durable record writer; a failure refuses all migration work. */
  persist: (record: DeploymentRecord) => void | Promise<void>;
  /** A database created by this operation, verified empty before its first migration. */
  freshDatabase?: boolean;
  report?: (line: string) => void;
  /** Resource preparation and recovery-ledger writes run only after admission. */
  prepare?: (record: DeploymentRecord) => Promise<DeploymentRecord>;
}

/** Admit and apply every hosted migration under the operator lease. */
export const applyCloudflareSchema = cloudflareOperation(async (options: SchemaOptions): Promise<DeploymentRecord> => {
  let record = options.record;
  if (options.accountId !== record.accountId) throw new Error('schema update refused: selected account does not match the deployment record');
  const database = { ...options, databaseName: record.databaseName };
  const before = await cloudflareSchemaVersion(database);
  if (before > SERVER_SCHEMA_VERSION) throw new Error(`schema update refused: D1 schema ${before} is newer than this binary's ${SERVER_SCHEMA_VERSION}`);
  if (options.freshDatabase && before !== 0) throw new Error('fresh D1 provisioning refused: the destination is not empty');
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
      const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
      options.report?.(`D1 Time Travel bookmark recorded for schema ${before} -> ${SERVER_SCHEMA_VERSION}: ${bookmark}`);
      const config = options.configFile === undefined ? '' : ` -c ${quote(path.join(options.configDir, options.configFile))}`;
      options.report?.(`Database rollback: CLOUDFLARE_ACCOUNT_ID=${quote(record.accountId)} npx --no-install wrangler d1 time-travel restore ${quote(record.databaseName)} --bookmark=${bookmark}${config}`);
      options.report?.('Confirm the restore prompt with y; it cancels in-flight queries and prints an undo bookmark.');
      options.report?.(record.versionId === null
        ? 'Roll back the Worker too if its code depends on the new schema; find the prior version with `wrangler deployments list`.'
        : `Roll back the Worker too if its code depends on the new schema: myco server rollback --target cloudflare --account-id=${quote(record.accountId)} --version=${quote(record.versionId)}`);
    }
  }
  record = await options.prepare?.(record) ?? record;
  if (before < SERVER_SCHEMA_VERSION) {
    await runCloudflareCommand(options, ['d1', 'migrations', 'apply', record.databaseName, '--remote']);
  }
  return record;
});
