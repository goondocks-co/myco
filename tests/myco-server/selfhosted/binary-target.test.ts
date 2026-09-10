/**
 * The self-hosted deployment as a compiled binary runs it.
 *
 * A binary carries its native artifacts and its dashboard, and it locates
 * neither on the host. Three things follow, and each is asserted here:
 *
 *   - the `vec0` extension loads from a path the deployment hands it, rather
 *     than one resolved through an installed package tree the binary has none
 *     of;
 *   - an explicit SQLite library wins over the host lookup, so a deployment
 *     carrying one serves on a machine that has none installed;
 *   - the dashboard is served from bytes the deployment holds, under the same
 *     rules the mounted-directory path serves under.
 *
 * `tests/myco-server/contract/server-bin.test.ts` holds the environment-driven
 * start unchanged; the two together are what "one core, two option sources"
 * means for this target.
 */
import { jsonBody } from '../../helpers/json-body.js';
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBunHandler } from '@myco-server-worker/entry/bun.js';
import { configureSqliteLibrary, resolveSqliteLibrary } from '@myco-server-worker/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '@myco-server-worker/platform/bun/vectors.js';
import { vectorId, type VectorMetadata } from '@myco-server-worker/core/embedding/vectors.js';
import { migrateOnly } from '@myco-server-worker/platform/bun/server-main.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { FRAME_HEADERS } from '@myco-server-worker/platform/bun/static.js';
import { memberPost, envelope } from '../helpers/fixtures.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const scratch = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'myco-binary-'));
  roots.push(root);
  return root;
};

const require_ = createRequire(import.meta.url);

/** The `vec0` artifact for this platform, as a path a deployment would carry. */
function vec0Path(): string {
  const target = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : process.platform === 'win32'
      ? 'windows-x64'
      : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
  const suffix = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
  const manifest = require_.resolve(`sqlite-vec-${target}/package.json`);
  return join(manifest, '..', `vec0.${suffix}`);
}

/**
 * The SQLite library a released binary embeds, when this checkout has it staged.
 *
 * `packages/myco/vendor-src/` is a build artifact and is absent from a fresh
 * worktree, so the assertion that uses it stands down where it is not there
 * rather than passing vacuously somewhere it could not have run.
 */
function carriedLibrary(): string | null {
  const target = process.platform === 'darwin'
    ? (process.arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64')
    : process.platform === 'win32'
      ? 'windows-x64'
      : (process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64');
  const name = process.platform === 'darwin' ? 'libsqlite3.dylib' : process.platform === 'win32' ? 'libsqlite3.dll' : 'libsqlite3.so';
  const staged = join(fileURLToPath(new URL('../../../', import.meta.url)), 'packages', 'myco', 'vendor-src', 'libsqlite3', target, name);
  return existsSync(staged) ? staged : null;
}

/** A migrated volume carrying one project and one member, plus the paths a deployment serves it from. */
function volume(): { databasePath: string; blobDir: string } {
  const root = scratch();
  const databasePath = join(root, 'myco.sqlite');
  migrateOnly(databasePath);
  const sqlite = new Database(databasePath);
  sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0)`).run();
  sqlite.query(`INSERT INTO members (id,label,created_at,revoked_at) VALUES ('mem_machine_1','machine_1',0,NULL)`).run();
  sqlite.close();
  return { databasePath, blobDir: join(root, 'blobs') };
}

/** A stored vector's metadata, whose record identity its id is derived from. */
const metadata = (recordId: string): VectorMetadata => ({
  type: 'spore', record_id: recordId, revision: 'r1', status: 'active', session_id: 'sess_1',
  created_at: 1_000, observation_type: 'discovery', release_state: 'none', release_confidence: 'none',
});

/** A dashboard build held as bytes, in the shape the generated module carries. */
const shell = (): Record<string, Uint8Array> => ({
  'index.html': new TextEncoder().encode('<!doctype html><title>Myco</title>'),
  'assets/app-abc123.js': new TextEncoder().encode('export const app = 1;'),
});

describe('the deployment a compiled binary runs', () => {
  it('loads the vector extension from the path it is handed, and ranks by cosine distance', async () => {
    configureSqliteLibrary({ library: null, vec0: null });
    const sqlite = new Database(':memory:');
    const store = sqliteVectorStore(sqlite, vec0Path());
    const scope = { projectId: 'proj_1', modelKey: 'm' };
    const near = await vectorId(scope, 'spore', 'rec_near', 'r1');
    const far = await vectorId(scope, 'spore', 'rec_far', 'r1');

    await store.upsert(scope, [
      { id: near, values: [1, 0, 0], metadata: metadata('rec_near') },
      { id: far, values: [0, 1, 0], metadata: metadata('rec_far') },
    ]);
    const ranked = await store.query(scope, { values: [1, 0, 0], topK: 2 });

    expect(ranked.map((r) => r.id)).toEqual([near, far]);
    expect(ranked[0]!.score).toBeCloseTo(1, 5);
    sqlite.close();
  });

  it('opens a database through the SQLite library it is handed, and loads the extension into it', async () => {
    // The headline claim of the binary target: a deployment carrying its own
    // library serves on a machine holding none. Asserted by actually opening
    // through a carried library and loading the extension into that
    // connection, rather than by trusting the resolver's answer.
    const carried = carriedLibrary();
    // CI stages this artifact before the suite runs, so an absent one there is
    // a broken pipeline rather than a checkout without build output — and a
    // silently skipped assertion is how this claim would go unproven.
    if (carried === null) {
      expect({ ci: process.env.CI ?? '', staged: false }).toEqual({ ci: '', staged: false });
      return;
    }

    configureSqliteLibrary({ library: carried, vec0: null });
    const sqlite = new Database(':memory:');
    const store = sqliteVectorStore(sqlite, vec0Path());
    const scope = { projectId: 'proj_1', modelKey: 'm' };
    const id = await vectorId(scope, 'spore', 'rec_carried', 'r1');
    await store.upsert(scope, [{ id, values: [1, 0, 0], metadata: metadata('rec_carried') }]);
    expect((await store.query(scope, { values: [1, 0, 0], topK: 1 })).map((r) => r.id)).toEqual([id]);
    sqlite.close();
  });

  it('chooses the SQLite library it is handed over the operator variable and the host lookup', () => {
    const carried = join(scratch(), 'libsqlite3-carried.dylib');
    const operator = join(scratch(), 'libsqlite3-operator.dylib');

    process.env.MYCO_SQLITE_LIBRARY = operator;
    try {
      // A carried artifact is what makes a deployment servable on a machine
      // holding no installed SQLite, so it outranks both other sources.
      expect(resolveSqliteLibrary({ library: carried, vec0: null })).toBe(carried);
      expect(resolveSqliteLibrary({ library: null, vec0: null })).toBe(operator);
    } finally {
      delete process.env.MYCO_SQLITE_LIBRARY;
    }

    // Naming none leaves the host lookup, which only macOS needs.
    if (process.platform === 'darwin') expect(typeof resolveSqliteLibrary()).toBe('string');
    else expect(resolveSqliteLibrary()).toBeUndefined();
  });

  it('serves a fresh volume with its dashboard carried as bytes, and admits a member prompt', async () => {
    const paths = volume();
    const handler = await createBunHandler({
      ...paths,
      header: 'x-forwarded-for',
      uiAssets: shell(),
      native: { library: null, vec0: vec0Path() },
      wakeLoop: false,
    });
    try {
      expect((await handler.fetch(new Request('https://s/health'))).status).toBe(200);

      const sqlite = new Database(paths.databasePath);
      const token = (await issueMemberToken(
        sqliteRelationalStore(sqlite),
        { memberId: 'mem_machine_1', machineId: 'machine_1' },
        Date.now(),
      )).token;
      sqlite.close();

      const request = memberPost(token, envelope());
      request.headers.set('x-forwarded-for', '203.0.113.7');
      expect(await jsonBody((await handler.fetch(request)))).toEqual({ persisted: true, projected: true });
    } finally {
      await handler.close();
    }
  });

  it('answers a deep route with the carried shell, refuses a traversal, and refuses a write to a path it does not own', async () => {
    const handler = await createBunHandler({
      ...volume(),
      header: 'x-forwarded-for',
      uiAssets: shell(),
      native: { library: null, vec0: vec0Path() },
      wakeLoop: false,
    });
    try {
      const deep = await handler.fetch(new Request('https://s/p/proj_1/sessions'));
      expect({ status: deep.status, type: deep.headers.get('content-type') })
        .toEqual({ status: 200, type: 'text/html; charset=utf-8' });
      // A shell that can be framed is a shell an attacker can wrap around a
      // page that binds an account to a member.
      expect(deep.headers.get('x-frame-options')).toBe(FRAME_HEADERS['x-frame-options']);

      const hashed = await handler.fetch(new Request('https://s/assets/app-abc123.js'));
      expect({ status: hashed.status, cache: hashed.headers.get('cache-control') })
        .toEqual({ status: 200, cache: 'public, max-age=31536000, immutable' });

      // Resolved against the build root, so a climb out of it lands back inside
      // and answers the shell rather than a file of the host's.
      const escape = await handler.fetch(new Request('https://s/../../etc/passwd'));
      expect(escape.status).toBe(200);
      expect(await escape.text()).toContain('<title>Myco</title>');

      const written = await handler.fetch(new Request('https://s/anywhere', { method: 'PUT' }));
      expect({ status: written.status, allow: written.headers.get('allow') })
        .toEqual({ status: 405, allow: 'GET, HEAD' });
    } finally {
      await handler.close();
    }
  });
});
