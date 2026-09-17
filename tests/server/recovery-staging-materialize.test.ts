/**
 * The staging this producer completes, materialized by the consumer that reads it: the manifest is written by the
 * producer's own stages over a staged export on disk, and `myco server materialize` turns it into a `/2` artifact.
 *
 * Nothing here hand-writes a manifest. What the hosted stages produce is exactly what the consumer is given.
 */
import { expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  ADVANCING_STAGES, continueAttempt, freshScan, PRODUCER_LIMITS,
  type AttemptCheckpoint, type AttemptObject, type AttemptPart, type AttemptState, type ProducerPorts,
  type ScanProgress,
} from '@myco-server-worker/core/recovery-producer.js';
import { newInventoryProgress, type InventoryObject, type InventoryProgress } from '@myco-server-worker/core/recovery-inventory.js';
import { STAGING_FORMAT, STAGING_MANIFEST_FILE, STAGING_OBJECTS_DIRECTORY } from '@myco-server-worker/core/recovery-staging.js';
import { tableColumns } from '@myco-server-worker/core/sql-statements.js';
import { snapshotObjectFacts } from '@myco/server/recovery-bundle.js';
import { stagingFixture } from './helpers/recovery-staging.js';

const digestOf = (body: Uint8Array | string): string => createHash('sha256').update(body).digest('hex');

/** A checkpoint in memory, with the durability rules the hosted object's storage gives the real one. */
function checkpoint(initial: Partial<AttemptState>) {
  const fresh = newInventoryProgress();
  const state: AttemptState = {
    id: 1, stage: 'inventory', prefix: 'staging', startedAt: 1_789_590_000_000, error: null, attempts: 0,
    bookmark: '00000004-00015960-000050e7-fixture', polls: 1, exportStartedAt: 0, exportCompletedAt: 0, reExports: 0,
    sqlBytes: null, sqlEtag: null, uploadId: null, downloadOffset: 0, reconcileOffset: 0, reconciled: 1,
    tables: [], captured: {},
    inventoryStartedAt: null, inventoryParts: 0, inventoryBytes: 0, inventoryScan: fresh.scan, inventoryScanBytes: '',
    inventoryDigest: null, databaseSha256: null, databaseBytes: null, copyStartedAt: null, completedAt: null,
    admission: null, ...freshScan(), ...initial,
  };
  const store = {
    state,
    held: [] as AttemptPart[],
    rows: [] as AttemptObject[],
    open: () => ((ADVANCING_STAGES as readonly string[]).includes(store.state.stage) ? { ...store.state } : null),
    update: (_id: number, fields: Partial<AttemptState>) => { Object.assign(store.state, fields); },
    parts: () => [...store.held].sort((left, right) => left.part - right.part),
    recordPart: (_id: number, part: AttemptPart, downloadOffset: number, progress: ScanProgress) => {
      store.held = [...store.held.filter((held) => held.part !== part.part), part];
      Object.assign(store.state, progress, { downloadOffset });
    },
    clearParts: () => { store.held = []; },
    recordInventory: (_id: number, progress: InventoryProgress, objects: readonly InventoryObject[]) => {
      for (const object of objects) {
        const already = store.rows.find((held) => held.key === object.key);
        if (already === undefined) store.rows.push({ ...object, stagedSha256: null, stagedBytes: null });
        else Object.assign(already, { bytes: object.bytes, sha256: object.sha256 });
      }
      Object.assign(store.state, {
        inventoryParts: progress.parts, inventoryBytes: progress.bytes, inventoryScan: progress.scan,
        inventoryScanBytes: progress.scanBytes, inventoryDigest: progress.digest,
      });
    },
    pendingObjects: (_id: number, limit: number) => store.rows.filter((held) => held.stagedSha256 === null).slice(0, limit),
    recordCopied: (_id: number, key: string, staged: { sha256: string; bytes: number }) => {
      const held = store.rows.find((object) => object.key === key);
      if (held !== undefined) Object.assign(held, { stagedSha256: staged.sha256, stagedBytes: staged.bytes });
    },
    objects: () => [...store.rows].sort((left, right) => (left.key < right.key ? -1 : 1)),
    objectCounts: () => ({
      registered: store.rows.length,
      staged: store.rows.filter((held) => held.stagedSha256 !== null).length,
    }),
    signedUrl: async () => null,
    setSignedUrl: async () => {},
  };
  return store as typeof store & AttemptCheckpoint;
}

it('completes a staging the materialize command accepts, over a real migrated source', async () => {
  const fixture = stagingFixture();
  try {
    // What the Deployment's own object store holds, and what a recovery must copy out of it.
    const sources: Record<string, Uint8Array> = {
      [`proj_1/${fixture.blobDigest}`]: fixture.bytes,
      [fixture.backupKey]: new TextEncoder().encode(fixture.backupBody),
    };
    // The copy stage is what puts the objects in the staging, so the fixture's own copies go first.
    fs.rmSync(path.join(fixture.staging, STAGING_OBJECTS_DIRECTORY), { recursive: true, force: true });

    // Admission's own open manifest, which completion keeps rather than writes again.
    const staged = fs.readFileSync(path.join(fixture.staging, 'd1.sql'));
    fixture.write({
      format: STAGING_FORMAT,
      source: fixture.manifest.source,
      status: 'open',
      startedAt: fixture.manifest.startedAt,
      schema: fixture.manifest.schema,
      configuration: fixture.manifest.configuration,
      credentialsRequired: fixture.manifest.credentialsRequired,
      objects: [],
    });

    const partBytes = 512;
    const parts: AttemptPart[] = [];
    for (let at = 0, part = 1; at < staged.byteLength; at += partBytes, part += 1) {
      const slice = staged.subarray(at, Math.min(at + partBytes, staged.byteLength));
      parts.push({ part, bytes: slice.byteLength, sha256: digestOf(slice), etag: `etag-${part}` });
    }

    // The captured definitions, as a capture of this very source holds them.
    const schema = JSON.parse(fs.readFileSync(path.join(fixture.staging, 'schema.json'), 'utf8')) as Array<{ name: string; sql: string; storage: string | null }>;
    const captured: Record<string, string> = {};
    for (const object of schema) {
      if (object.storage === 'table' && tableColumns(object.sql) !== null) captured[object.name] = object.sql;
    }

    const port: ProducerPorts = {
      now: () => 1_789_590_060_000,
      async pollExport() { throw new Error('a staged export polls nothing'); },
      async readRange() { throw new Error('a staged export reads no signed range'); },
      async writePart() { throw new Error('a staged export writes no part'); },
      async beginUpload() { throw new Error('a staged export begins no upload'); },
      async completeUpload() { return null; },
      async abortUpload() {},
      async readStoredRange() { return null; },
      async storedSize() { return staged.byteLength; },
      async readStagedPart(_prefix, offset, bytes) {
        return new Uint8Array(staged.subarray(offset, offset + bytes));
      },
      digest: async (bytes) => digestOf(bytes),
      async copyObject(_prefix, { key }, expected) {
        const body = sources[key];
        if (body === undefined) return { status: 'missing' };
        const measured = digestOf(body);
        if (expected.sha256 !== null && measured !== expected.sha256) {
          return { status: 'error', failure: { cause: 'provider', status: null, transient: false } };
        }
        const file = path.join(fixture.staging, STAGING_OBJECTS_DIRECTORY, ...key.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, body);
        return { status: 'copied', sha256: measured, bytes: body.byteLength };
      },
      async writeStagingFile(_prefix, name, body) {
        fs.writeFileSync(path.join(fixture.staging, name), body);
      },
      async readStagingFile(_prefix, name) {
        const file = path.join(fixture.staging, name);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
      },
    };

    const state = checkpoint({
      sqlBytes: staged.byteLength, captured, tables: Object.keys(captured),
      // What the checkpoint owner recorded when it published the open manifest above.
      admission: {
        source: fixture.manifest.source, startedAt: fixture.manifest.startedAt, schema: fixture.manifest.schema,
        configuration: fixture.manifest.configuration, credentialsRequired: fixture.manifest.credentialsRequired,
      },
    });
    state.held = parts;
    let report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, maxPartsPerStep: 2, maxObjectsPerStep: 1 });
    for (let step = 0; step < 128 && report.nextInMs !== null; step += 1) {
      report = await continueAttempt(state, port, { ...PRODUCER_LIMITS, maxPartsPerStep: 2, maxObjectsPerStep: 1 });
    }
    expect([report.stage, report.error]).toEqual(['complete', undefined]);

    // The inventory the export's own rows name is the object set the canonical snapshot reader registers.
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.staging, STAGING_MANIFEST_FILE), 'utf8')) as {
      status: string; database: { sha256: string; bytes: number }; objects: Array<{ key: string; bytes: number; sha256: string }>;
    };
    expect(manifest.status).toBe('complete');
    expect(manifest.database).toEqual({ sha256: digestOf(staged), bytes: staged.byteLength });

    // The consumer's own command, on the manifest the producer wrote.
    const artifact = await fixture.materialize();
    expect([artifact.format, artifact.status]).toEqual(['myco-recovery/2', 'complete']);

    // The object set the materialized snapshot registers is exactly what the manifest listed.
    const facts = snapshotObjectFacts(path.join(fixture.destination, 'myco.sqlite'));
    expect(manifest.objects.map((object) => object.key).sort()).toEqual([...facts.keys()].sort());
    for (const object of manifest.objects) {
      const held = facts.get(object.key)!;
      expect({ key: object.key, bytes: object.bytes }).toEqual({ key: object.key, bytes: held.bytes });
      // A row that records a digest is held to it; a row that records none is staged under the digest of its copy.
      if (held.sha256 !== null) expect(object.sha256).toBe(held.sha256);
      else expect(object.sha256).toBe(digestOf(sources[object.key]!));
    }
  } finally { fixture.cleanup(); }
});
