import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { resetEmbeddingIndex } from '@myco-server-worker/core/embedding/reconcile.js';
import { assignRestoreGeneration, resetRecoveryLedger } from '@myco-server-worker/core/object-release.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import { atomicWriteFileSync, syncDirectoryForDurability } from '@myco/utils/atomic-write.js';
import { cloudflareOperation } from './cloudflare-operation.js';
import { cloudflareResources } from './cloudflare-resources.js';
import { copyRecoveryBundle, copyRecoveryObjects, preparedObjectKeys, restoredFleet, verifyRecoveryBundle } from './recovery-bundle.js';
import { prepareRecoveryCredentials } from './recovery-credentials.js';
import { restoreCloudflareDatabase } from './cloudflare-recovery-database.js';
import { stageCloudflareDeploy, stageCloudflareRecoveryBootstrap } from './cloudflare-stage.js';
import {
  assertWranglerReady, ensureCommandDir, readDeploymentRecord, writeDeploymentRecord,
  ensureDatabase, ensureBucket, ensureVectorIndexResource, ensureVectorIndexFilters, ensureSecretsStore,
  cloudflareObjectStore, assertCloudflareWorkerAbsent, putStoreSecret, putWorkerSecretValue, putWorkerSecrets, deployWorker,
  type CloudflareFetch, type DeploymentRecord,
} from './cloudflare.js';
import type { LifecycleOptions } from './cloudflare-lifecycle.js';

const journalSchema = z.object({
  format: z.literal('myco-hosted-recovery/1'), accountId: z.string().min(1),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  name: z.string().regex(/^myco-recovery-[a-f0-9]{24}$/),
  databaseId: z.string().optional(), bucketCreated: z.boolean().default(false),
  recoveryBucketCreated: z.boolean().default(false),
  vectorCreated: z.boolean().default(false), storeId: z.string().optional(),
  wrapKeyInstalled: z.boolean().default(false), url: z.string().url().optional(),
  pending: z.string().optional(),
  versionId: z.string().optional(), deployedAt: z.string().datetime().optional(),
  schemaVersion: z.number().int().positive().optional(), preparedFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  newSignIn: z.boolean().default(false),
  vectorProvisioned: z.boolean().default(false),
});
type Journal = z.infer<typeof journalSchema>;

async function databaseFingerprint(file: string): Promise<string> {
  if (!fs.lstatSync(file).isFile()) throw new Error('prepared recovery database must be a regular file');
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

/** Restore a fresh hosted Deployment; resource receipts survive interruption and no source resources are adopted. */
export const restoreCloudflareDeployment = cloudflareOperation(async (options: LifecycleOptions & {
  source: string; secretsFile: string; newSignIn?: boolean; native?: NativeSqlite; fetch?: CloudflareFetch;
}): Promise<{ record: DeploymentRecord; schemaVersion: number; rebuildEmbeddings: true }> => {
  if (readDeploymentRecord(options.mycoHome) !== null) throw new Error('hosted recovery requires a fresh MYCO_HOME without a Cloudflare Deployment record');
  const root = ensureCommandDir(options.mycoHome);
  const journalFile = path.join(root, 'recovery.json');
  const journalEntry = fs.lstatSync(journalFile, { throwIfNoEntry: false });
  if (journalEntry !== undefined && !journalEntry.isFile()) throw new Error('hosted recovery journal must be a regular file');
  if (journalEntry === undefined && fs.readdirSync(root).length > 0) throw new Error('hosted recovery destination holds unrelated files; choose a fresh MYCO_HOME');
  const { secrets, key } = await prepareRecoveryCredentials(options.source, options.secretsFile, options.newSignIn);
  let journal = journalEntry === undefined ? undefined : journalSchema.parse(JSON.parse(fs.readFileSync(journalFile, 'utf8')));
  if (journal !== undefined && journal.accountId !== options.accountId) throw new Error('hosted recovery journal belongs to another Cloudflare account');
  if (journal !== undefined && journal.newSignIn !== (options.newSignIn ?? false)) throw new Error('resume hosted recovery with the same sign-in choice');
  if (journal?.pending !== undefined) throw new Error(`hosted recovery has an unconfirmed ${journal.pending} operation; reconcile the named replacement resource before retrying`);

  const artifact = path.join(root, 'recovery-source');
  const manifest = await verifyRecoveryBundle(options.source, options.report);
  const fingerprint = manifest.snapshot!.database.sha256;
  if (journal !== undefined && journal.fingerprint !== fingerprint) throw new Error('hosted recovery journal belongs to another source snapshot');
  const write = (next: Journal) => {
    atomicWriteFileSync(journalFile, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, durable: true });
    journal = next;
  };
  if (journal === undefined) write({ format: 'myco-hosted-recovery/1', accountId: options.accountId, fingerprint,
    name: `myco-recovery-${randomBytes(12).toString('hex')}`, bucketCreated: false, recoveryBucketCreated: false, vectorCreated: false, vectorProvisioned: false, wrapKeyInstalled: false, newSignIn: options.newSignIn ?? false });
  const held = () => journal!;
  const confirmed = (fields: Partial<Journal>) => {
    const { pending: _pending, ...prior } = held();
    write({ ...prior, ...fields });
  };
  const resource = async <T>(name: string, create: () => Promise<T>, receipt: (value: T) => Partial<Journal>) => {
    write({ ...held(), pending: name });
    const result = await create();
    confirmed(receipt(result));
  };
  const provision = async <T extends { created: boolean }>(name: string, create: () => Promise<T>, receipt: (value: T) => Partial<Journal>) =>
    resource(name, async () => {
      const result = await create();
      if (!result.created) throw new Error(`refusing to adopt existing ${name}`);
      return result;
    }, receipt);

  const name = held().name;
  const carried = restoredFleet(manifest.snapshot!.configuration);
  const fleet = carried.fleet ?? undefined;
  const makeRecord = (): DeploymentRecord => ({
    accountId: options.accountId, workerName: name, databaseName: name, bucketName: name,
    vectorIndexName: name, wrapKeySecretName: name, recoveryBucketName: cloudflareResources({ workerName: name }).recoveryBucketName,
    ...(held().databaseId === undefined ? {} : { databaseId: held().databaseId! }),
    ...(held().storeId === undefined ? {} : { storeId: held().storeId! }),
    ...(held().url === undefined ? {} : { url: held().url! }),
    ...(fleet === undefined ? {} : { fleet }),
    versionId: held().versionId ?? null, deployedAt: held().deployedAt ?? new Date().toISOString(),
  });
  if (held().versionId !== undefined) {
    if (held().schemaVersion === undefined || held().deployedAt === undefined || held().url === undefined
      || held().databaseId === undefined || held().storeId === undefined) throw new Error('hosted recovery publication receipt is incomplete');
    const record = makeRecord();
    writeDeploymentRecord(record, options.mycoHome);
    return { record, schemaVersion: held().schemaVersion!, rebuildEmbeddings: true };
  }

  await copyRecoveryBundle(options.source, artifact, options.report);
  options.report?.(carried.report);

  const databasePath = path.join(root, 'recovery.sqlite');
  const db = new Database(path.join(artifact, 'myco.sqlite'), { readonly: true, create: false });
  try {
    const saved = await deploymentSecretStore(sqliteRelationalStore(db), key).list();
    if (saved.some((secret) => !secret.readable)) throw new Error('recovery wrapping key cannot open all stored credentials');
  } finally { db.close(); }
  if (held().preparedFingerprint === undefined) {
    const staging = fs.mkdtempSync(path.join(root, '.recovery-data-'));
    try {
      const prepared = path.join(staging, 'myco.sqlite');
      fs.copyFileSync(path.join(artifact, 'myco.sqlite'), prepared, fs.constants.COPYFILE_EXCL);
      const data = new Database(prepared);
      try {
        const store = sqliteRelationalStore(data);
        for (const project of data.query<{ project_id: string }, []>('SELECT project_id FROM projects').all()) {
          await resetEmbeddingIndex(store, project.project_id);
        }
      } finally { data.close(); }
      // The one migration applier brings the copy to the bundled schema, so the import stamps every step it holds and
      // the destination applies none twice. The source's object lifecycle is cleared, and every registered blob is
      // named under one fresh restore generation the objects are copied to.
      migrateOnly(prepared, options.native);
      const lifecycle = new Database(prepared);
      try {
        const store = sqliteRelationalStore(lifecycle);
        await resetRecoveryLedger(store);
        await assignRestoreGeneration(store, crypto.randomUUID());
      } finally { lifecycle.close(); }
      const fd = fs.openSync(prepared, 'r+');
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.renameSync(prepared, databasePath);
      syncDirectoryForDurability(root);
      confirmed({ preparedFingerprint: await databaseFingerprint(databasePath) });
    } finally { fs.rmSync(staging, { recursive: true, force: true }); }
  }
  if (await databaseFingerprint(databasePath) !== held().preparedFingerprint) throw new Error('prepared recovery database changed; no remote data was written');
  const bare = { ...options, configDir: root };
  await assertWranglerReady({ ...(options.runner === undefined ? {} : { runner: options.runner }), cwd: root,
    ...(options.report === undefined ? {} : { report: options.report }) });
  if (held().databaseId === undefined) await provision(`D1 ${name}`, () => ensureDatabase({ ...bare, databaseName: name }), (result) => ({ databaseId: result.databaseId }));
  if (!held().bucketCreated) await provision(`R2 ${name}`, () => ensureBucket({ ...bare, bucketName: name }), () => ({ bucketCreated: true }));
  const stagingName = cloudflareResources({ workerName: name }).recoveryBucketName;
  if (!held().recoveryBucketCreated) {
    await provision(`R2 ${stagingName}`, () => ensureBucket({ ...bare, bucketName: stagingName }), () => ({ recoveryBucketCreated: true }));
  }
  if (!held().vectorCreated) {
    if (!held().vectorProvisioned) await provision(`Vectorize ${name}`, () => ensureVectorIndexResource({ ...bare, vectorIndexName: name, requireNew: true }), () => ({ vectorProvisioned: true }));
    await ensureVectorIndexFilters({ ...bare, vectorIndexName: name });
    confirmed({ vectorCreated: true });
  }
  if (held().storeId === undefined) confirmed({ storeId: (await ensureSecretsStore(bare)).storeId });
  if (!held().wrapKeyInstalled) await resource(`wrapping secret ${name}`, () => putStoreSecret({ ...bare,
    storeId: held().storeId!, name, value: secrets.SECRET_WRAP_KEY }), () => ({ wrapKeyInstalled: true }));

  let record = makeRecord();
  const staged = stageCloudflareDeploy(record, options.mycoHome);
  const restored = await restoreCloudflareDatabase({ ...bare, configDir: staged.dir, configFile: staged.configFile,
    databaseName: name, databasePath, sourceFingerprint: fingerprint });
  await copyRecoveryObjects(artifact, cloudflareObjectStore({ ...bare, bucketName: name }), preparedObjectKeys(databasePath), options.report);
  if (held().url === undefined) {
    await assertCloudflareWorkerAbsent({ ...bare, workerName: name });
    const bootstrap = stageCloudflareRecoveryBootstrap(record, options.mycoHome);
    await resource(`Worker ${name}`, () => deployWorker({ ...bare, configDir: bootstrap.dir, configFile: bootstrap.configFile }), (result) => {
      if (result.url === null) throw new Error('recovery bootstrap returned no Worker URL');
      return { url: result.url };
    });
  }
  record = { ...record, url: held().url! };
  await putWorkerSecretValue({ ...bare, workerName: name, name: 'SESSION_SECRET', value: secrets.SESSION_SECRET });
  if ('GITHUB_CLIENT_ID' in secrets) {
    await putWorkerSecrets({ accountId: options.accountId, workerName: name,
      ...(options.mycoHome === undefined ? {} : { mycoHome: options.mycoHome }),
      ...(options.runner === undefined ? {} : { runner: options.runner }),
    }, { GITHUB_CLIENT_ID: secrets.GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET: secrets.GITHUB_CLIENT_SECRET });
  }
  const final = stageCloudflareDeploy(record, options.mycoHome);
  await resource(`publication of Worker ${name}`, () => deployWorker({ ...bare, configDir: final.dir, configFile: final.configFile }), (deployed) => {
    if (deployed.versionId === null) throw new Error('recovery deployment returned no Worker version; the operator record was not published');
    return { versionId: deployed.versionId, deployedAt: new Date().toISOString(), schemaVersion: restored.schemaVersion };
  });
  record = makeRecord();
  writeDeploymentRecord(record, options.mycoHome);
  options.report?.('Replacement deployed. Verify sign-in, persisted artifacts, workers and embedding readiness before cutover.');
  return { record, schemaVersion: restored.schemaVersion, rebuildEmbeddings: true };
});
