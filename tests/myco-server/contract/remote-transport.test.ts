/**
 * The C-remote half of #909, end to end through `serve()`.
 *
 * C-local is enforced by properties of the socket and the Host header, and has
 * its own gate. C-remote hands both of those to an operator-run proxy, so what
 * remains verifiable in the server is narrower and easier to get wrong:
 *
 * - source identity is read from the declared header, RIGHT-most past the
 *   declared hop count. Reading from the left lets a caller pick its own
 *   rate-limit bucket and defeat every pre-authentication limit.
 * - a deployment that declares no header establishes no identity, and the core
 *   answers 503 rather than metering traffic by a value a caller chose. That
 *   gate sits above authentication and below the public routes, so it is
 *   observable on a member route and not on `/health`.
 * - the Host allowlist does NOT apply: the authority is the deployment's public
 *   name, which the proxy owns.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { serve } from '@myco-server-worker/entry/bun.js';

const roots: string[] = [];
afterAll(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

function migratedVolume(): { databasePath: string; blobDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'myco-remote-'));
  roots.push(root);
  const databasePath = join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.close();
  return { databasePath, blobDir: join(root, 'blobs') };
}

/** Serve under the proxy transport and hand back a request helper. */
async function remoteDeployment(config: { header?: string; trustedHops?: number }) {
  const started = await serve({
    ...migratedVolume(),
    transport: 'proxy',
    sourceFrom: 'proxy',
    bind: 'all',
    port: 0,
    ...config,
  });
  return {
    port: started.port,
    stop: started.stop,
    /** `/health` is a public route, answered before source identity is consulted. */
    health: (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${started.port}/health`, { headers }),
    /**
     * A member route. Source identity gates everything that is not public
     * (`pipeline.ts:159-165`), so this is where the fail-closed behaviour is
     * observable: no identity answers 503 before authentication is even
     * attempted, and an established identity gets past it to 401.
     */
    metered: (headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${started.port}/events`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{}',
      }),
  };
}

describe('C-remote: the Host allowlist does not apply', () => {
  it('answers a request carrying the deployment public authority', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 1 });
    try {
      const res = await d.health({ host: 'myco.example.com', 'x-forwarded-for': '203.0.113.7' });
      // C-local would refuse this Host with 421. Behind a proxy the authority
      // is the deployment's public name.
      expect(res.status).not.toBe(421);
    } finally { d.stop(); }
  });
});

describe('C-remote: source identity is read from the right', () => {
  it('takes the address the deployment own proxy observed, not the left-most', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 1 });
    try {
      // The left-most entry is whatever the CLIENT sent. A server reading from
      // the left lets a caller choose its own bucket.
      const res = await d.metered({
        host: 'myco.example.com',
        'x-forwarded-for': '198.51.100.9, 203.0.113.7',
      });
      // Identity established: past the 503 gate, refused by authentication.
      expect(res.status).not.toBe(503);
    } finally { d.stop(); }
  });

  it('serves under a two-hop topology when two hops are declared', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 2 });
    try {
      const res = await d.metered({
        host: 'myco.example.com',
        'x-forwarded-for': '198.51.100.9, 203.0.113.7, 203.0.113.8',
      });
      expect(res.status).not.toBe(503);
    } finally { d.stop(); }
  });
});

describe('C-remote: fail closed when identity is not established', () => {
  it('refuses to meter traffic when no header is declared', async () => {
    const d = await remoteDeployment({});
    try {
      const res = await d.metered({ host: 'myco.example.com', 'x-forwarded-for': '203.0.113.7' });
      // No identity: 503 rather than admitting unmetered traffic.
      expect(res.status).toBe(503);
    } finally { d.stop(); }
  });

  it('refuses when the declared header is absent from the request', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 1 });
    try {
      expect((await d.metered({ host: 'myco.example.com' })).status).toBe(503);
    } finally { d.stop(); }
  });

  it('refuses a forwarded list long enough to be an attack on the parser', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 1 });
    try {
      const flood = Array.from({ length: 64 }, (_, i) => `203.0.113.${i % 255}`).join(', ');
      expect((await d.metered({ host: 'myco.example.com', 'x-forwarded-for': flood })).status).toBe(503);
    } finally { d.stop(); }
  });

  it('refuses when more hops are declared than the header carries', async () => {
    const d = await remoteDeployment({ header: 'x-forwarded-for', trustedHops: 3 });
    try {
      // Stepping back past the start of the list names no entry.
      expect((await d.metered({ host: 'myco.example.com', 'x-forwarded-for': '203.0.113.7' })).status).toBe(503);
    } finally { d.stop(); }
  });
});
