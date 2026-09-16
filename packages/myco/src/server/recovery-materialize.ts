/**
 * Materialize a `myco-recovery/3` staging into a verified `myco-recovery/2` artifact, locally and with no provider
 * call. Every byte this consumes is pinned into the artifact's own work directory and held to the digest the staging
 * records for it, the snapshot's own rows must match the staging inventory exactly, and the artifact is bound to the
 * staging identity it came from. Nothing here writes to the staging.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRecoveryBundle, fingerprintFile, snapshotObjectFacts, type RecoveryManifest } from './recovery-bundle.js';
import {
  stagingIdentity, stagingManifestSchema, STAGING_MANIFEST_FILE, STAGING_OBJECTS_DIRECTORY, STAGING_SCHEMA_FILE,
  STAGING_SQL_FILE, type RecoveryFingerprint, type RecoveryStagingManifest, type RecoveryStagingObject,
} from './recovery-contract.js';
import { buildSnapshotDatabase } from './recovery-snapshot.js';
import { schemaObjects } from './recovery-schema.js';

/** The canonical path a caller named, with every existing component resolved. */
function canonical(target: string): string {
  const resolved = path.resolve(target);
  let head = resolved;
  const tail: string[] = [];
  for (;;) {
    if (fs.existsSync(head)) return path.join(fs.realpathSync(head), ...tail);
    const parent = path.dirname(head);
    if (parent === head) return resolved;
    tail.unshift(path.basename(head));
    head = parent;
  }
}

/** A regular file inside the staging, with no symlink anywhere in its path. */
function stagedFile(root: string, ...parts: string[]): string {
  const file = path.join(root, ...parts);
  const held = fs.lstatSync(file, { throwIfNoEntry: false });
  if (held === undefined) throw new Error(`recovery staging is missing ${parts.join('/')}`);
  if (!held.isFile()) throw new Error(`recovery staging entry must be a regular file: ${parts.join('/')}`);
  if (fs.realpathSync(file) !== file) throw new Error(`recovery staging path leaves the staging: ${parts.join('/')}`);
  return file;
}

function readStagingManifest(root: string): RecoveryStagingManifest {
  const manifest = stagingManifestSchema.parse(JSON.parse(fs.readFileSync(stagedFile(root, STAGING_MANIFEST_FILE), 'utf8')));
  if (manifest.status !== 'complete') throw new Error('recovery staging is incomplete; only a completed staging materializes');
  return manifest;
}

/** Copies a staged file into the artifact's work directory and holds the copy to its recorded fingerprint. */
async function pinStagedFile(file: string, into: string, expected: RecoveryFingerprint, what: string): Promise<string> {
  fs.rmSync(into, { force: true });
  fs.copyFileSync(file, into, fs.constants.COPYFILE_EXCL);
  const actual = await fingerprintFile(into);
  if (actual.sha256 !== expected.sha256 || actual.bytes !== expected.bytes) {
    fs.rmSync(into, { force: true });
    throw new Error(`recovery staging ${what} does not match its recorded fingerprint`);
  }
  return into;
}

/** Holds the staging inventory to the snapshot's own object set: every key, no extras, and matching sizes and digests. */
function assertInventoryCovers(snapshot: string, inventory: Map<string, RecoveryStagingObject>): void {
  const registered = snapshotObjectFacts(snapshot);
  const missing = [...registered.keys()].filter((key) => !inventory.has(key));
  const extra = [...inventory.keys()].filter((key) => !registered.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`recovery staging inventory does not match its snapshot: ${missing.length} absent, ${extra.length} unregistered`);
  }
  for (const [key, expected] of registered) {
    const staged = inventory.get(key)!;
    if (staged.bytes !== expected.bytes) throw new Error(`recovery staging lists ${key} with a different size than its snapshot`);
    if (expected.sha256 !== null && expected.sha256 !== staged.sha256) {
      throw new Error(`recovery staging lists ${key} with a different digest than its snapshot`);
    }
  }
}

export interface MaterializeOptions {
  staging: string;
  destination: string;
  report?: (line: string) => void;
}

export async function materializeRecoveryStaging(options: MaterializeOptions): Promise<RecoveryManifest> {
  const given = path.resolve(options.staging);
  if (!fs.lstatSync(given, { throwIfNoEntry: false })?.isDirectory()) throw new Error('recovery staging must be a directory, not a symlink');
  const staging = canonical(given);
  const destination = canonical(options.destination);
  const report = options.report ?? (() => {});
  if (destination === staging || destination.startsWith(staging + path.sep) || staging.startsWith(destination + path.sep)) {
    throw new Error('recovery staging and its destination must not overlap');
  }
  const manifest = readStagingManifest(staging);
  const inventory = new Map<string, RecoveryStagingObject>(manifest.objects.map((object) => [object.key, object]));
  const sqlFile = stagedFile(staging, STAGING_SQL_FILE);
  const schemaFile = stagedFile(staging, STAGING_SCHEMA_FILE);
  report(`Materializing a ${manifest.format} staging of ${manifest.source.locator}`);

  return createRecoveryBundle(destination, {
    source: { ...manifest.source, receipt: stagingIdentity(manifest) },
    snapshot: async (file, workDir) => {
      const sql = await pinStagedFile(sqlFile, path.join(workDir, 'staged-d1.sql'), manifest.database, 'SQL export');
      const schema = schemaObjects.parse(JSON.parse(fs.readFileSync(
        await pinStagedFile(schemaFile, path.join(workDir, 'staged-schema.json'), manifest.schema, 'schema capture'), 'utf8')));
      report('Reconstructing the snapshot from the staged export');
      await buildSnapshotDatabase(file, sql, schema);
      assertInventoryCovers(file, inventory);
      return { configuration: manifest.configuration, credentialsRequired: manifest.credentialsRequired };
    },
    blob: async (object, workDir) => {
      const staged = inventory.get(object.key);
      if (staged === undefined) throw new Error(`recovery staging inventory does not list ${object.key}`);
      const file = stagedFile(staging, STAGING_OBJECTS_DIRECTORY, ...object.key.split('/'));
      const pinned = await pinStagedFile(file, path.join(workDir, 'staged-object'), { sha256: staged.sha256, bytes: staged.bytes }, `object ${object.key}`);
      return Bun.file(pinned).stream();
    },
  }, report);
}
