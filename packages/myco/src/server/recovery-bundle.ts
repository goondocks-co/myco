import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { Database } from 'bun:sqlite';
import { diskBlobStore, sweepPartialObjects } from '@myco-server-worker/platform/bun/blobs.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { BLOB_KEY_GRAMMAR, PROJECTED_BLOB_REFERENCES, KINDS, blobFields } from '@myco-server-worker/ingest/kinds.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';

const MANIFEST_FILE = 'recovery.json';
const DATABASE_FILE = 'myco.sqlite';
const LOCK_FILE = '.recovery.lock';
const SNAPSHOT_DIRECTORY = '.snapshot';
const OWNER_DIRECTORY_MODE = 0o700;
const OWNER_FILE_MODE = 0o600;
const DIGEST = BLOB_KEY_GRAMMAR;

const fingerprintSchema = z.object({ sha256: z.string().regex(DIGEST), bytes: z.number().int().nonnegative() });
const sourceSchema = z.object({ target: z.enum(['local', 'cloudflare']), locator: z.string().min(1) });
const blobSchema = z.object({ key: z.string(), sha256: z.string().regex(DIGEST), bytes: z.number().int().nonnegative() });
const snapshotSchema = z.object({
  deploymentId: z.string().min(1), schemaVersion: z.number().int().positive(),
  database: fingerprintSchema, blobCount: z.number().int().nonnegative(), blobBytes: z.number().int().nonnegative(),
  configuration: z.record(z.string(), z.unknown()),
  credentialsRequired: z.array(z.string()), capturedAt: z.string().datetime(),
});
const manifestSchema = z.object({
  format: z.literal('myco-recovery/1'), source: sourceSchema, startedAt: z.string().datetime(),
  status: z.enum(['snapshot', 'content', 'complete']), snapshot: snapshotSchema.optional(),
  completedAt: z.string().datetime().optional(),
}).superRefine((value, ctx) => {
  if (value.status !== 'snapshot' && value.snapshot === undefined) ctx.addIssue({ code: 'custom', message: 'recovery snapshot is missing' });
  if (value.status === 'complete' && value.completedAt === undefined) ctx.addIssue({ code: 'custom', message: 'recovery completion time is missing' });
});

export type RecoverySource = z.infer<typeof sourceSchema>;
export type RecoveryBlob = z.infer<typeof blobSchema>;
export type RecoverySnapshot = Pick<z.infer<typeof snapshotSchema>, 'configuration' | 'credentialsRequired'>;
export type RecoveryManifest = z.infer<typeof manifestSchema>;

export interface RecoveryAdapter {
  source: RecoverySource;
  /** Write a closed standalone database at databasePath, using workDir for intermediate files. */
  snapshot(databasePath: string, workDir: string): Promise<RecoverySnapshot>;
  /** Stream the content-addressed bytes from this source, or throw on absence. */
  blob(blob: RecoveryBlob, workDir: string): Promise<ReadableStream>;
}

/** Size and digest from the same bounded-memory read of a regular file. */
async function fingerprint(file: string): Promise<z.infer<typeof fingerprintSchema>> {
  if (!fs.lstatSync(file).isFile()) throw new Error(`recovery content is not a regular file: ${file}`);
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of fs.createReadStream(file)) { hash.update(chunk); bytes += chunk.length; }
  return { sha256: hash.digest('hex'), bytes };
}

function sameFingerprint(actual: z.infer<typeof fingerprintSchema>, expected: z.infer<typeof fingerprintSchema>): boolean {
  return actual.sha256 === expected.sha256 && actual.bytes === expected.bytes;
}

function blobPath(root: string, blob: RecoveryBlob): string {
  const parts = blob.key.split('/');
  if (parts.length !== 2 || !parts[0] || parts[0] === '.' || parts[0] === '..'
    || parts[0].includes('\\') || parts[0].includes(':') || parts[1] !== blob.sha256 || !DIGEST.test(blob.sha256)) {
    throw new Error(`invalid recovery blob key: ${blob.key}`);
  }
  return path.join(root, 'blobs', ...parts);
}

/** Publish only after the referenced bytes and their directory entry have been flushed. */
function syncFile(file: string): void {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}

function syncDirectory(directory: string): void {
  if (process.platform !== 'win32') {
    const fd = fs.openSync(directory, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
}

function writeManifest(root: string, manifest: RecoveryManifest): void {
  atomicWriteFileSync(path.join(root, MANIFEST_FILE), JSON.stringify(manifest, null, 2) + '\n', { mode: OWNER_FILE_MODE, durable: true });
}

function readManifest(root: string): RecoveryManifest | null {
  const file = path.join(root, MANIFEST_FILE);
  if (!fs.existsSync(file)) return null;
  if (!fs.lstatSync(file).isFile()) throw new Error('recovery manifest must be a regular file');
  return manifestSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
}

function openSnapshot(file: string): Database {
  const db = new Database(file, { readonly: true, create: false });
  try {
    const integrity = db.query<{ integrity_check: string }, []>('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('recovery database failed its integrity check');
    if (db.query('PRAGMA foreign_key_check').get() !== null) throw new Error('recovery database has broken foreign keys');
    for (const { table, column } of PROJECTED_BLOB_REFERENCES) {
      if (db.query(`SELECT 1 FROM ${table} r WHERE r.${column} IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = r.project_id AND b.key = r.${column}) LIMIT 1`).get() !== null) {
        throw new Error(`recovery database is missing a blob referenced by ${table}.${column}`);
      }
    }
    for (const kind of KINDS.filter((kind) => kind.projection === 'raw' && blobFields(kind).length > 0)) {
      if (db.query(`SELECT 1 FROM events e WHERE e.kind = ? AND e.blob_key IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM blobs b WHERE b.project_id = e.project_id AND b.key = e.blob_key) LIMIT 1`).get(kind.name) !== null) {
        throw new Error(`recovery database is missing a blob referenced by ${kind.name}`);
      }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

function snapshotFacts(db: Database) {
  const deploymentId = db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'deployment_id'").get()?.value;
  const schemaVersion = Number(db.query<{ value: string }, []>("SELECT value FROM schema_meta WHERE key = 'version'").get()?.value);
  if (!deploymentId || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1 || schemaVersion > SERVER_SCHEMA_VERSION) {
    throw new Error('recovery database has no supported Deployment identity and schema');
  }
  const counts = db.query<{ blobCount: number; blobBytes: number }, []>('SELECT COUNT(*) AS blobCount, COALESCE(SUM(size), 0) AS blobBytes FROM blobs').get()!;
  return { deploymentId, schemaVersion, ...counts };
}

function assertOwnedDirectory(root: string): void {
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: OWNER_DIRECTORY_MODE });
    syncDirectory(path.dirname(root));
  }
  if (!fs.lstatSync(root).isDirectory()) throw new Error('recovery destination must be a directory, not a symlink');
  const lock = path.join(root, LOCK_FILE);
  if (fs.existsSync(lock) && !fs.lstatSync(lock).isFile()) throw new Error('recovery lock must be a regular file');
  if (!fs.existsSync(path.join(root, MANIFEST_FILE)) && fs.readdirSync(root).some((name) => name !== LOCK_FILE)) {
    throw new Error('recovery destination holds unrelated files; choose an empty directory');
  }
}

function ensureContentDirectory(directory: string, complete = false): void {
  if (!fs.existsSync(directory)) {
    if (complete) throw new Error(`completed recovery artifact is missing directory ${directory}`);
    fs.mkdirSync(directory, { mode: OWNER_DIRECTORY_MODE });
    syncDirectory(path.dirname(directory));
  }
  if (!fs.lstatSync(directory).isDirectory()) throw new Error(`recovery content directory must not be a symlink: ${directory}`);
}

/** One writer owns snapshot publication, content verification and the final completion manifest on both targets. */
export async function createRecoveryBundle(
  destination: string, adapter: RecoveryAdapter, report: (line: string) => void = () => {},
): Promise<RecoveryManifest> {
  const root = path.resolve(destination);
  assertOwnedDirectory(root);
  const held = LifecycleLock.acquire(path.join(root, LOCK_FILE), { command: 'myco server backup' });
  if (!held.acquired) throw new Error('another backup owns this recovery destination');
  try {
    assertOwnedDirectory(root);
    fs.chmodSync(root, OWNER_DIRECTORY_MODE);
    let manifest = readManifest(root);
    if (manifest !== null && (manifest.source.target !== adapter.source.target || manifest.source.locator !== adapter.source.locator)) {
      throw new Error('recovery destination belongs to another Deployment');
    }
    if (manifest === null) {
      manifest = { format: 'myco-recovery/1', source: sourceSchema.parse(adapter.source), startedAt: new Date().toISOString(), status: 'snapshot' };
      writeManifest(root, manifest);
    }
    const databasePath = path.join(root, DATABASE_FILE);
    const workDir = path.join(root, SNAPSHOT_DIRECTORY);
    if (manifest.status === 'snapshot') {
      report('Capturing the database snapshot');
      fs.rmSync(workDir, { recursive: true, force: true });
      fs.mkdirSync(workDir, { mode: OWNER_DIRECTORY_MODE });
      const incoming = path.join(workDir, DATABASE_FILE);
      const captured = await adapter.snapshot(incoming, workDir);
      const db = openSnapshot(incoming);
      let facts;
      try { facts = snapshotFacts(db); } finally { db.close(); }
      const snapshot = snapshotSchema.parse({ ...captured, ...facts, database: await fingerprint(incoming), capturedAt: new Date().toISOString() });
      fs.chmodSync(incoming, OWNER_FILE_MODE);
      syncFile(incoming);
      fs.renameSync(incoming, databasePath);
      syncFile(databasePath);
      manifest = { ...manifest, status: 'content', snapshot };
      writeManifest(root, manifest);
    }
    const snapshot = manifest.snapshot!;
    if (!sameFingerprint(await fingerprint(databasePath), snapshot.database)) throw new Error('recovery database no longer matches its manifest');
    const store = diskBlobStore(path.join(root, 'blobs'));
    ensureContentDirectory(workDir);
    ensureContentDirectory(path.join(root, 'blobs'), manifest.status === 'complete');
    const db = openSnapshot(databasePath);
    try {
      const facts = snapshotFacts(db);
      if (facts.deploymentId !== snapshot.deploymentId || facts.schemaVersion !== snapshot.schemaVersion
        || facts.blobCount !== snapshot.blobCount || facts.blobBytes !== snapshot.blobBytes) throw new Error('recovery manifest does not describe its database');
      let index = 0;
      const rows = db.query<RecoveryBlob, []>("SELECT project_id || '/' || key AS key, key AS sha256, size AS bytes FROM blobs ORDER BY project_id, key");
      for (const row of rows.iterate()) {
        const blob = blobSchema.parse(row);
        const file = blobPath(root, blob);
        ensureContentDirectory(path.dirname(file), manifest.status === 'complete');
        index += 1;
        if (fs.existsSync(file)) {
          if (sameFingerprint(await fingerprint(file), blob)) continue;
          if (manifest.status === 'complete') throw new Error(`completed recovery blob no longer matches its manifest: ${blob.key}`);
          await store.delete(blob.key);
        }
        if (manifest.status === 'complete') throw new Error(`completed recovery artifact is missing blob ${blob.key}`);
        report(`Copying blob ${index} of ${snapshot.blobCount}`);
        const stored = await store.put(blob.key, await adapter.blob(blob, workDir), { sha256: blob.sha256 });
        if (stored.size !== blob.bytes) { await store.delete(blob.key); throw new Error(`recovery blob has an unexpected size: ${blob.key}`); }
        fs.chmodSync(file, OWNER_FILE_MODE);
        syncFile(file);
      }
    } finally { db.close(); }
    fs.rmSync(workDir, { recursive: true, force: true });
    await sweepPartialObjects(path.join(root, 'blobs'));
    if (manifest.status !== 'complete') {
      manifest = { ...manifest, status: 'complete', completedAt: new Date().toISOString() };
      writeManifest(root, manifest);
    }
    return manifest;
  } finally { held.lock.release(); }
}
