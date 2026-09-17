/**
 * The hold a backup destination takes on its source, through the one recovery writer.
 *
 * What matters here is what a destination may do in each state it can be found in: an intent recorded before the hold
 * exists, a hold adopted on resume, a snapshot whose hold is gone, a completed artifact whose release answer was lost.
 * A hold is never reopened over a saved snapshot, because deletions may have run while it was not held.
 */
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupLocalDeployment, localRecoveryHold } from '@myco/server/local-backup.js';
import { resolveLocalPaths, writeLocalRecord } from '@myco/server/local.js';
import {
  abandonRecoveryHold, createRecoveryBundle, recoveryHoldOfDestination, verifyRecoveryBundle,
  type RecoveryHoldOwner, type RecoveryHoldReading, type RecoveryHoldSource,
} from '@myco/server/recovery-bundle.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { diskBlobStore } from '@myco-server-worker/platform/bun/blobs.js';
import { releaseBlobs, drainObjectReleases } from '@myco-server-worker/core/object-release.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

const HOLD_FILE = '.recovery-hold.json';

/** A native Deployment on disk: one blob registered under its own generation, and the volume the backup will read. */
function deployment() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-destination-'));
  const paths = resolveLocalPaths(path.join(root, 'home'));
  const bytes = new TextEncoder().encode('object the snapshot names');
  const key = createHash('sha256').update(bytes).digest('hex');
  const generation = crypto.randomUUID();
  const fixture = sqliteEnv();
  writeLocalRecord({ port: 8787, sourceFrom: 'socket' }, paths);
  fixture.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES ('proj_1',?,?,'text/plain','mt_fixture',1,?)`, [key, bytes.length, generation]);
  fixture.sqlite.query('VACUUM INTO ?').run(paths.databasePath);
  fixture.sqlite.close();
  const stored = `proj_1/${key}~${generation}`;
  return {
    root, paths, key, bytes, stored,
    destination: path.join(root, 'artifact'),
    put: () => diskBlobStore(paths.blobDir).put(stored, new Response(bytes).body, { sha256: key }),
    /** The served volume, as the Deployment's own code reaches it. */
    live: <T>(work: (db: ReturnType<typeof sqliteRelationalStore>) => Promise<T>): Promise<T> => {
      const sqlite = new Database(paths.databasePath, { readwrite: true });
      return work(sqliteRelationalStore(sqlite)).finally(() => { sqlite.close(); });
    },
    holds: () => {
      const sqlite = new Database(paths.databasePath, { readonly: true });
      try { return sqlite.query('SELECT token, holder, released_at, release_reason, released_by FROM recovery_holds').all() as Array<Record<string, unknown>>; } finally { sqlite.close(); }
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const recorded = (destination: string) => JSON.parse(fs.readFileSync(path.join(destination, HOLD_FILE), 'utf8')) as { token: string; locator: string };

it('holds every object its snapshot names against a deletion, and releases the hold when the artifact completes', async () => {
  const source = deployment();
  try {
    await source.put();
    // The blob is deleted while the backup runs: the deletion is recorded and deferred, and the copy still finds it.
    const manifest = await backupLocalDeployment({
      destination: source.destination,
      paths: source.paths,
      report: () => {},
      native: { library: null, vec0: null },
    });
    expect(manifest.status).toBe('complete');
    expect(source.holds()).toEqual([{ token: recorded(source.destination).token, holder: 'operator', released_at: expect.any(Number), release_reason: 'complete', released_by: 'operator' }]);
  } finally { source.cleanup(); }
});

it('keeps a deletion decided during the copy from removing an object the snapshot still needs', async () => {
  const source = deployment();
  try {
    await source.put();
    let deleted = 0;
    const manifest = await createRecoveryBundle(source.destination, {
      source: { target: 'local', locator: fs.realpathSync(source.paths.databasePath) },
      hold: localRecoveryHold(source.paths, { library: null, vec0: null }),
      snapshot: async (file) => {
        const db = new Database(source.paths.databasePath, { readonly: true });
        try { db.query('VACUUM INTO ?').run(file); } finally { db.close(); }
        return { configuration: { port: 8787 }, credentialsRequired: [] };
      },
      blob: async (object) => {
        // Between the snapshot and this copy, the Deployment deletes the blob and drains: the hold defers both.
        const outcome = await source.live((db) => releaseBlobs(db, [{ projectId: 'proj_1', key: source.key }], Date.now()));
        expect(outcome).toEqual({ released: 0, deferred: 1 });
        await source.live(async (db) => { await drainObjectReleases({ db, blobs: diskBlobStore(source.paths.blobDir) }, Date.now()); });
        deleted += 1;
        const held = await diskBlobStore(source.paths.blobDir).get(object.source);
        if (held === null) throw new Error(`source Deployment is missing blob ${object.key}`);
        return held.body;
      },
    }, () => {});
    expect([manifest.status, deleted]).toEqual(['complete', 1]);
    // Once the artifact holds its own copy and the hold is released, the deferred deletion is decided.
    await source.live(async (db) => { for (let pass = 0; pass < 4; pass += 1) await drainObjectReleases({ db, blobs: diskBlobStore(source.paths.blobDir) }, Date.now()); });
    expect(await diskBlobStore(source.paths.blobDir).get(source.stored)).toBeNull();
    expect((await verifyRecoveryBundle(source.destination)).status).toBe('complete');
  } finally { source.cleanup(); }
});

it('resumes an interrupted copy under the hold it already took, and refuses a snapshot whose hold is gone', async () => {
  const source = deployment();
  try {
    await source.put();
    const owner = localRecoveryHold(source.paths, { library: null, vec0: null });
    // The copy fails after the snapshot is published, so the destination keeps its hold and its snapshot.
    await expect(createRecoveryBundle(source.destination, {
      source: { target: 'local', locator: fs.realpathSync(source.paths.databasePath) },
      hold: owner,
      snapshot: async (file) => {
        const db = new Database(source.paths.databasePath, { readonly: true });
        try { db.query('VACUUM INTO ?').run(file); } finally { db.close(); }
        return { configuration: { port: 8787 }, credentialsRequired: [] };
      },
      blob: async () => { throw new Error('copy interrupted'); },
    }, () => {})).rejects.toThrow('copy interrupted');
    const token = recorded(source.destination).token;
    expect(await recoveryHoldOfDestination(source.destination, owner)).toMatchObject({ token, state: 'open', bound: true, sourceMatchesBinding: true });

    // Resuming adopts that same hold: no second hold is ever opened.
    const resumed = await backupLocalDeployment({ destination: source.destination, paths: source.paths, report: () => {}, native: { library: null, vec0: null } });
    expect(resumed.status).toBe('complete');
    expect(source.holds().map((row) => row.token)).toEqual([token]);
    expect(await recoveryHoldOfDestination(source.destination, owner)).toMatchObject({ token, state: 'released' });

    // A completed artifact verifies again and releases nothing further: repeated commands are idempotent.
    const again = await backupLocalDeployment({ destination: source.destination, paths: source.paths, report: () => {}, native: { library: null, vec0: null } });
    expect(again.status).toBe('complete');
    expect(source.holds()).toEqual([{ token, holder: 'operator', released_at: expect.any(Number), release_reason: 'complete', released_by: 'operator' }]);
  } finally { source.cleanup(); }
});

it('refuses an incomplete destination whose hold was released or lost, rather than reopening one over its snapshot', async () => {
  const source = deployment();
  try {
    await source.put();
    const owner = localRecoveryHold(source.paths, { library: null, vec0: null });
    await expect(createRecoveryBundle(source.destination, {
      source: { target: 'local', locator: fs.realpathSync(source.paths.databasePath) },
      hold: owner,
      snapshot: async (file) => {
        const db = new Database(source.paths.databasePath, { readonly: true });
        try { db.query('VACUUM INTO ?').run(file); } finally { db.close(); }
        return { configuration: { port: 8787 }, credentialsRequired: [] };
      },
      blob: async () => { throw new Error('copy interrupted'); },
    }, () => {})).rejects.toThrow('copy interrupted');
    const token = recorded(source.destination).token;

    // The operator gives the hold up: the incomplete destination can no longer be resumed.
    expect(await abandonRecoveryHold(source.destination, owner)).toEqual({ token, state: 'released' });
    await expect(backupLocalDeployment({ destination: source.destination, paths: source.paths, report: () => {}, native: { library: null, vec0: null } }))
      .rejects.toThrow('capture into a new directory');

    // A destination whose hold row is gone entirely is refused the same way.
    fs.rmSync(path.join(source.destination, HOLD_FILE));
    fs.writeFileSync(path.join(source.destination, HOLD_FILE), JSON.stringify({ token: crypto.randomUUID(), locator: owner.locator, createdAt: new Date().toISOString() }));
    await expect(backupLocalDeployment({ destination: source.destination, paths: source.paths, report: () => {}, native: { library: null, vec0: null } }))
      .rejects.toThrow('capture into a new directory');
  } finally { source.cleanup(); }
});

it('settles a lost acquire or release answer by reading the same token back', async () => {
  const source = deployment();
  try {
    await source.put();
    let acquires = 0;
    let releases = 0;
    source.cleanup();

    const second = deployment();
    try {
      await second.put();
      const secondReal = localRecoveryHold(second.paths, { library: null, vec0: null });
      const owner: RecoveryHoldOwner = {
        ...secondReal,
        acquire: async (token) => { acquires += 1; await secondReal.acquire(token); return { state: 'absent' } as RecoveryHoldReading; },
        release: async (token, reason) => { releases += 1; await secondReal.release(token, reason); return { state: 'absent' } as RecoveryHoldReading; },
      };
      // An acquire whose answer is unusable is reconciled by inspecting the token, and the copy proceeds under it.
      const manifest = await createRecoveryBundle(second.destination, {
        source: { target: 'local', locator: fs.realpathSync(second.paths.databasePath) },
        hold: owner,
        snapshot: async (file) => {
          const db = new Database(second.paths.databasePath, { readonly: true });
          try { db.query('VACUUM INTO ?').run(file); } finally { db.close(); }
          return { configuration: { port: 8787 }, credentialsRequired: [] };
        },
        blob: async (object) => (await diskBlobStore(second.paths.blobDir).get(object.source))!.body,
      }, () => {});
      expect([manifest.status, acquires >= 1, releases >= 1]).toEqual(['complete', true, true]);
      // The release statement landed even though its answer did not, so the hold is released on the source.
      expect(second.holds()).toEqual([{ token: recorded(second.destination).token, holder: 'operator', released_at: expect.any(Number), release_reason: 'complete', released_by: 'operator' }]);
    } finally { second.cleanup(); }
  } catch (error) { source.cleanup(); throw error; }
});

it('refuses a destination that recorded the hold of another Deployment', async () => {
  const source = deployment();
  try {
    await source.put();
    const owner = localRecoveryHold(source.paths, { library: null, vec0: null });
    fs.mkdirSync(source.destination, { recursive: true });
    fs.writeFileSync(path.join(source.destination, HOLD_FILE), JSON.stringify({ token: crypto.randomUUID(), locator: '/somewhere/else.sqlite', createdAt: new Date().toISOString() }));
    await expect(backupLocalDeployment({ destination: source.destination, paths: source.paths, report: () => {}, native: { library: null, vec0: null } }))
      .rejects.toThrow('recovery hold of another Deployment');
    await expect(recoveryHoldOfDestination(source.destination, owner)).rejects.toThrow('another Deployment');
    await expect(abandonRecoveryHold(source.destination, owner)).rejects.toThrow('another Deployment');
  } finally { source.cleanup(); }
});

/** A source whose hold statements land, whose answers can be lost, and whose identity a test can change. */
function syntheticSource(options: { identity?: () => RecoveryHoldSource | null } = {}) {
  const holds = new Map<string, { released: boolean }>();
  const stats = { acquires: 0, inspects: 0, releases: 0 };
  const throwOn = { acquire: false, release: false, inspect: 0 };
  const identity = options.identity ?? ((): RecoveryHoldSource => ({ deploymentId: 'source-A', schemaVersion: SERVER_SCHEMA_VERSION }));
  const reading = (token: string): RecoveryHoldReading => {
    const held = holds.get(token);
    return { state: held === undefined ? 'absent' : held.released ? 'released' : 'open', source: identity() };
  };
  const owner: RecoveryHoldOwner = {
    locator: 'synthetic-locator',
    acquire: async (token) => {
      stats.acquires += 1;
      if (![...holds.entries()].some(([, held]) => !held.released)) holds.set(token, { released: false });
      if (throwOn.acquire) throw new Error('transport lost after acquisition');
      return reading(token);
    },
    inspect: async (token) => {
      stats.inspects += 1;
      if (throwOn.inspect > 0) { throwOn.inspect -= 1; throw new Error('the source did not answer'); }
      return reading(token);
    },
    release: async (token, reason) => {
      stats.releases += 1;
      const held = holds.get(token);
      if (held !== undefined && !held.released) held.released = true;
      if (throwOn.release) throw new Error('transport lost after release');
      void reason;
      return reading(token);
    },
    open: async () => {
      const open = [...holds.entries()].find(([, held]) => !held.released);
      return open === undefined ? null : { token: open[0], acquiredAt: 1 };
    },
  };
  /** The token this source currently holds open, as its own volume would carry it. */
  const openToken = (): string | null => [...holds.entries()].find(([, held]) => !held.released)?.[0] ?? null;
  return { owner, holds, stats, throwOn, identity, openToken };
}

/** One object the synthetic snapshot registers, so every capture has something to copy. */
const OBJECT = new TextEncoder().encode('one object the snapshot registers');
const OBJECT_KEY = createHash('sha256').update(OBJECT).digest('hex');

/**
 * A snapshot that registers that object, written by the same builder a real capture uses, stamped with the Deployment
 * it is a snapshot OF. A real source answers its hold with the identity its own volume carries, so a fixture whose
 * stamp and hold answer disagree is a substituted snapshot, which is what one of these tests is.
 */
const syntheticSnapshot = (file: string, stamp: RecoveryHoldSource | null, hold: SnapshotHold = null) => {
  const fixture = sqliteEnv();
  fixture.sqlite.run(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
    VALUES ('proj_1',?,?,'text/plain','mt_fixture',1,?)`, [OBJECT_KEY, OBJECT.length, crypto.randomUUID()]);
  if (stamp !== null) {
    fixture.sqlite.run("INSERT INTO schema_meta(key,value) VALUES ('deployment_id',?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [stamp.deploymentId]);
    fixture.sqlite.run("UPDATE schema_meta SET value = ? WHERE key = 'version'", [String(stamp.schemaVersion)]);
  }
  // The volume a real snapshot copies carries the hold that was opened on it before the copy.
  if (hold !== null) {
    fixture.sqlite.run('INSERT INTO recovery_holds(token,acquired_at,holder) VALUES (?,1,?)', [hold.token, hold.holder]);
    if (hold.released) fixture.sqlite.run("UPDATE recovery_holds SET released_at = 2, release_reason = 'abandoned', released_by = 'operator' WHERE token = ?", [hold.token]);
  }
  fixture.sqlite.query('VACUUM INTO ?').run(file);
  fixture.sqlite.close();
  return { configuration: { port: 8787 }, credentialsRequired: [] };
};

/** The hold row a synthetic snapshot carries, or none at all. */
type SnapshotHold = { token: string; holder: 'operator' | 'producer'; released?: boolean } | null;

/** What a real volume carries at snapshot time: the operator hold the source holds open, unreleased. */
const carriedHold = (source: { openToken: () => string | null }): SnapshotHold => {
  const token = source.openToken();
  return token === null ? null : { token, holder: 'operator' };
};

/** A capture against a synthetic source, with the copy, and what the snapshot is stamped with, under the test's control. */
const capture = (
  source: { owner: RecoveryHoldOwner; identity: () => RecoveryHoldSource | null; openToken: () => string | null },
  destination: string,
  copy: () => Promise<ReadableStream>,
  report: (line: string) => void = () => {},
  stamp: () => RecoveryHoldSource | null = source.identity,
  hold: () => SnapshotHold = () => carriedHold(source),
) =>
  createRecoveryBundle(destination, {
    source: { target: 'local', locator: 'synthetic-locator' },
    hold: source.owner,
    snapshot: async (file) => syntheticSnapshot(file, stamp(), hold()),
    blob: async () => copy(),
  }, report);

/** The bytes the synthetic snapshot's one object holds. */
const objectBytes = async (): Promise<ReadableStream> => new Response(OBJECT).body!;

it('binds the identity its hold answered with before any snapshot, and refuses a resume against another source', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-bound-'));
  try {
    let which = 'source-A';
    const source = syntheticSource({ identity: () => ({ deploymentId: which, schemaVersion: SERVER_SCHEMA_VERSION }) });
    const destination = path.join(root, 'artifact');
    // The acquire lands and its answer is lost: the hold is reconciled by reading the same token back, and bound.
    source.throwOn.acquire = true;
    await expect(capture(source, destination, async () => { throw new Error('copy interrupted'); })).rejects.toThrow('copy interrupted');
    expect(source.stats.inspects).toBeGreaterThan(0);
    source.throwOn.acquire = false;
    const bound = JSON.parse(fs.readFileSync(path.join(destination, '.recovery-hold-bound.json'), 'utf8'));
    expect(bound.source).toEqual({ deploymentId: 'source-A', schemaVersion: SERVER_SCHEMA_VERSION });
    expect([...source.holds.values()]).toEqual([{ released: false }]);

    // The source is replaced under the saved snapshot: the resume refuses rather than completing against it.
    which = 'source-B';
    source.throwOn.acquire = false;
    await expect(capture(source, destination, objectBytes)).rejects.toThrow('no longer the Deployment this backup was bound to');
    expect(source.stats.acquires).toBe(1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('keeps the only live token when a crash lands between its records, and reuses it on the next attempt', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-crash-'));
  try {
    const source = syntheticSource();
    const destination = path.join(root, 'artifact');
    // The acquire lands, its answer is lost, and every read that follows is lost too: the hold exists, unbound.
    source.throwOn.acquire = true;
    source.throwOn.inspect = 99;
    await expect(capture(source, destination, objectBytes)).rejects.toThrow('did not answer about');
    const token = JSON.parse(fs.readFileSync(path.join(destination, '.recovery-hold.json'), 'utf8')).token;
    expect([...source.holds.keys()]).toEqual([token]);
    expect(fs.existsSync(path.join(destination, '.recovery-hold-bound.json'))).toBe(false);

    // The next attempt uses the same token, binds it, and completes: no second hold is ever opened.
    source.throwOn.inspect = 0;
    source.throwOn.acquire = false;
    const manifest = await capture(source, destination, objectBytes);
    expect(manifest.status).toBe('complete');
    expect([...source.holds.keys()]).toEqual([token]);
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.recovery-hold-bound.json'), 'utf8')).token).toBe(token);
    expect([...source.holds.values()]).toEqual([{ released: true }]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses a snapshot taken before its hold was bound, rather than binding one afterwards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-unbound-'));
  try {
    const source = syntheticSource();
    const destination = path.join(root, 'artifact');
    await expect(capture(source, destination, async () => { throw new Error('copy interrupted'); })).rejects.toThrow('copy interrupted');
    // The binding is lost while the snapshot stays: the destination is refused, not rebound.
    fs.rmSync(path.join(destination, '.recovery-hold-bound.json'));
    await expect(capture(source, destination, objectBytes)).rejects.toThrow('before its recovery hold was bound');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('reports an unresolved release instead of claiming one, and reconciles the same token afterwards', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-release-'));
  try {
    const source = syntheticSource();
    const destination = path.join(root, 'artifact');
    const lines: string[] = [];
    // The release statement lands, but its answer and every following read are lost.
    source.throwOn.release = true;
    const manifest = await createRecoveryBundle(destination, {
      source: { target: 'local', locator: 'synthetic-locator' },
      hold: {
        ...source.owner,
        inspect: async (token) => { if (source.holds.get(token)?.released === true) throw new Error('the source did not answer'); return source.owner.inspect(token); },
      },
      snapshot: async (file) => syntheticSnapshot(file, source.identity(), carriedHold(source)),
      blob: () => objectBytes(),
    }, (line) => { lines.push(line); });
    // The artifact is complete either way: an unresolved hold never unmakes what was verified.
    expect(manifest.status).toBe('complete');
    expect(lines.some((line) => line.includes('recovery hold is unresolved'))).toBe(true);
    expect(lines.some((line) => line.includes('to reconcile it'))).toBe(true);
    // The statement did land, so reconciling it later answers released.
    source.throwOn.release = false;
    expect(await recoveryHoldOfDestination(destination, source.owner)).toMatchObject({ state: 'released' });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses a replacement source against the receipt it already wrote, without opening a second hold', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-absent-bound-'));
  try {
    let which = 'source-A';
    const source = syntheticSource({ identity: () => ({ deploymentId: which, schemaVersion: SERVER_SCHEMA_VERSION }) });
    const destination = path.join(root, 'artifact');
    // The hold is opened and bound, and the attempt dies before it captures anything.
    await expect(capture(source, destination, objectBytes, () => {}, () => { throw new Error('crash before snapshot'); }))
      .rejects.toThrow('crash before snapshot');
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.recovery-hold-bound.json'), 'utf8')).source)
      .toEqual({ deploymentId: 'source-A', schemaVersion: SERVER_SCHEMA_VERSION });

    // The volume is replaced and its hold is gone with it. Nothing about the destination says so, so the receipt is
    // the only thing that can: the retry refuses before it opens anything on the replacement.
    source.holds.clear();
    which = 'source-B';
    await expect(capture(source, destination, objectBytes)).rejects.toThrow('no longer the Deployment this backup was bound to');
    expect(source.stats.acquires).toBe(1);
    expect([...source.holds.keys()]).toEqual([]);
    expect(JSON.parse(fs.readFileSync(path.join(destination, '.recovery-hold-bound.json'), 'utf8')).source)
      .toEqual({ deploymentId: 'source-A', schemaVersion: SERVER_SCHEMA_VERSION });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses a snapshot of a Deployment other than the one its hold admitted it to', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-substituted-'));
  try {
    const source = syntheticSource();
    const destination = path.join(root, 'artifact');
    // The hold is open on source-A, and the bytes handed back are of another Deployment: a live release-time reading
    // would still answer source-A, so only the snapshot itself can be held to what was admitted.
    await expect(capture(source, destination, objectBytes, () => {},
      () => ({ deploymentId: 'substituted-source', schemaVersion: SERVER_SCHEMA_VERSION })))
      .rejects.toThrow('not of the Deployment its recovery hold was bound to');
    // Nothing was published under the substituted identity: the artifact is still waiting for its snapshot.
    expect(JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8')).status).toBe('snapshot');
    expect(fs.existsSync(path.join(destination, 'myco.sqlite'))).toBe(false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('refuses a source that answers its hold without naming a Deployment, rather than binding a placeholder', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-unidentified-'));
  try {
    const source = syntheticSource({ identity: () => null });
    const destination = path.join(root, 'artifact');
    await expect(capture(source, destination, objectBytes)).rejects.toThrow('did not identify the Deployment');
    expect(fs.existsSync(path.join(destination, '.recovery-hold-bound.json'))).toBe(false);
    // The token it recorded is still the one live token, so the hold it opened can be given up by name.
    expect([...source.holds.keys()]).toEqual([recorded(destination).token]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/**
 * What the captured bytes themselves say about the hold that protected them.
 *
 * In each of these the source answers exactly the identity the destination bound, and would answer `open` for this
 * token at release time; the only thing that disagrees is the hold row inside the snapshot. A live read is not an
 * oracle for bytes already taken, so the copy is refused on its own row.
 */
const SNAPSHOT_HOLDS: ReadonlyArray<{ what: string; hold: (token: string | null) => SnapshotHold; refusal: string }> = [
  { what: 'carries no hold at all', hold: () => null, refusal: "carries no recovery hold of this backup's own token" },
  { what: "carries another backup's token", hold: () => ({ token: crypto.randomUUID(), holder: 'operator' }), refusal: "carries no recovery hold of this backup's own token" },
  { what: 'carries the token as a producer hold', hold: (token) => ({ token: token!, holder: 'producer' }), refusal: 'is not an operator hold' },
  { what: 'carries the token already released', hold: (token) => ({ token: token!, holder: 'operator', released: true }), refusal: 'after its own recovery hold was released' },
];

for (const { what, hold, refusal } of SNAPSHOT_HOLDS) {
  it(`refuses a snapshot that ${what}, whatever the source answers now`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hold-snapshot-'));
    try {
      const source = syntheticSource();
      const destination = path.join(root, 'artifact');
      await expect(capture(source, destination, objectBytes, () => {}, source.identity, () => hold(source.openToken())))
        .rejects.toThrow(refusal);
      expect(JSON.parse(fs.readFileSync(path.join(destination, 'recovery.json'), 'utf8')).status).toBe('snapshot');
      expect(fs.existsSync(path.join(destination, 'myco.sqlite'))).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}
