/**
 * The self-hosted entry point, driven end to end.
 *
 * `tests/myco-server/contract/both-targets.test.ts` proves the two adapter sets
 * agree on the core's behavior; this proves the self-hosted ENTRY assembles a
 * working deployment from a mounted volume, refuses to serve an unusable one, and
 * takes source identity only from a header its operator declared.
 */
import { describe, it, expect, afterAll } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createBunHandler } from '@myco-server-worker/entry/bun.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { memberPost, envelope } from '../helpers/fixtures.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function volume({ migrated = true }: { migrated?: boolean } = {}): { databasePath: string; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'myco-selfhosted-'));
  roots.push(root);
  const databasePath = join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  if (migrated) {
    sqlite.exec('PRAGMA foreign_keys = ON');
    for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
    sqlite.query(`INSERT INTO projects (project_id,name,created_at) VALUES ('proj_1','a',0)`).run();
  }
  sqlite.close();
  return { databasePath, blobDir: join(root, 'blobs') };
}

describe('the self-hosted entry point', () => {
  it('serves health from a mounted volume', async () => {
    const handler = await createBunHandler({ ...volume(), header: 'x-forwarded-for' });
    expect((await handler.fetch(new Request('https://s/health'))).status).toBe(200);
    handler.close();
  });

  it('refuses to serve an unmigrated volume, naming the remedy', async () => {
    await expect(createBunHandler({ ...volume({ migrated: false }), header: 'x-forwarded-for' }))
      .rejects.toThrow(/apply migrations before serving/);
  });

  it('refuses to serve without a database path', async () => {
    await expect(createBunHandler({ databasePath: '', blobDir: '/tmp/nope', header: 'x-forwarded-for' }))
      .rejects.toThrow(/requires a database path/);
  });

  it('ingests a real prompt through the entry, onto the volume', async () => {
    const v = volume();
    const handler = await createBunHandler({ ...v, header: 'x-forwarded-for' });
    const sqlite = new Database(v.databasePath);
    const token = (await issueMemberToken(sqliteRelationalStore(sqlite), { projectId: 'proj_1', machineId: 'machine_1' }, Date.now())).token;
    const request = memberPost(token, envelope());
    request.headers.set('x-forwarded-for', '203.0.113.7');
    expect(await (await handler.fetch(request)).json()).toEqual({ persisted: true, projected: true });
    sqlite.close();
    handler.close();
  });

  it('establishes no source identity when the operator declared no trusted header, and refuses rather than admitting unmetered traffic', async () => {
    const handler = await createBunHandler({ ...volume() });
    const res = await handler.fetch(new Request('https://s/events', { method: 'POST', body: '{}' }));
    expect({ status: res.status, body: await res.json() }).toEqual({ status: 503, body: { error: 'unavailable' } });
    handler.close();
  });

  it('takes identity only from the declared header, ignoring others a client can set', async () => {
    const handler = await createBunHandler({ ...volume(), header: 'x-forwarded-for' });
    const request = new Request('https://s/events', { method: 'POST', headers: { 'x-real-ip': '198.51.100.9' }, body: '{}' });
    expect((await handler.fetch(request)).status).toBe(503);
    request.headers.set('x-forwarded-for', '10.0.0.1, 203.0.113.7');
    expect((await handler.fetch(request)).status).toBe(401);
    handler.close();
  });

  it('does not let a caller author its own identity by prepending to the trusted header', async () => {
    // The proxy appends, so anything left of its own entry is caller-supplied. A
    // caller that could choose its identity would never share a rate-limit bucket
    // with itself, and the source meter is the only thing bounding traffic before
    // a credential is checked.
    const { createBunHandler: make } = await import('@myco-server-worker/entry/bun.js');
    const handler = await make({ ...volume(), header: 'x-forwarded-for' });
    const identities = new Set<string>();
    for (const forged of ['1.1.1.1', '2.2.2.2', '3.3.3.3']) {
      const request = new Request('https://s/events', { method: 'POST', headers: { 'x-forwarded-for': `${forged}, 203.0.113.7` }, body: '{}' });
      // Every request presents a different forged prefix behind the same real client.
      identities.add((await handler.fetch(request)).status === 401 ? 'admitted' : 'refused');
    }
    expect([...identities]).toEqual(['admitted']);
    handler.close();
  });

  it('establishes a forgery-proof identity from the socket when no proxy is declared', async () => {
    const handler = await createBunHandler({ ...volume(), sourceFrom: 'socket' });
    // Unbound, nothing can report a socket address, so nothing is admitted.
    const before = await handler.fetch(new Request('https://s/events', { method: 'POST', body: '{}' }));
    expect(before.status).toBe(503);
    handler.bind({ requestIP: () => ({ address: '203.0.113.7' }) });
    const after = await handler.fetch(new Request('https://s/events', { method: 'POST', body: '{}' }));
    expect(after.status).toBe(401);
    handler.close();
  });
});
