/**
 * SIGTERM asks for a drain, and the drain has to be awaited.
 *
 * `stop_grace_period` in the Compose bundle only means something if the process
 * actually uses the window. Two ways it silently does not: exiting on the same
 * tick as the stop call, and closing the database handle while requests are
 * still executing against it. Neither shows up as a failed test elsewhere —
 * both surface as an occasional 500 for a caller the orchestrator asked to let
 * finish.
 *
 * A drain keeps serving the connections it already holds, which is the point of
 * it. Asserting "the port answers nothing" over a pooled keep-alive socket
 * therefore tests the connection pool rather than the listener; the assertions
 * below force a fresh connection where the listener is what is under test.
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
  const root = mkdtempSync(join(tmpdir(), 'myco-drain-'));
  roots.push(root);
  const databasePath = join(root, 'myco.sqlite');
  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.close();
  return { databasePath, blobDir: join(root, 'blobs') };
}

describe('drain', () => {
  it('accepts no NEW connection once the drain resolves', async () => {
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    const authority = `127.0.0.1:${started.port}`;

    // `connection: close` matters. A drain deliberately keeps serving the
    // connections it already holds, so a pooled keep-alive socket answers 200
    // after the drain resolves, which proves nothing about the listener.
    const before = await fetch(`http://${authority}/health`, {
      headers: { host: authority, connection: 'close' },
    });
    expect(before.status).toBe(200);

    await started.stop();

    let servedAfterStop = false;
    try {
      const res = await fetch(`http://${authority}/health`, {
        headers: { host: authority, connection: 'close' },
      });
      servedAfterStop = res.status === 200;
    } catch { servedAfterStop = false; }
    expect(servedAfterStop).toBe(false);
  });

  it('lets requests already in flight finish', async () => {
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    const authority = `127.0.0.1:${started.port}`;

    // Issued, then given a tick to reach the socket. Calling stop() on the same
    // tick tests nothing: the connections have not been made yet, so they fail
    // to connect rather than being drained.
    const inFlight = Array.from({ length: 8 }, () =>
      fetch(`http://${authority}/health`, { headers: { host: authority } }));
    await new Promise((resolve) => setTimeout(resolve, 25));

    await started.stop();

    const settled = await Promise.allSettled(inFlight);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    // Closing the database under them turns a request into a 500 rather than a
    // rejection, so status is asserted, not just settlement.
    for (const s of fulfilled) {
      expect((s as PromiseFulfilledResult<Response>).value.status).toBe(200);
    }
    expect(fulfilled.length).toBeGreaterThan(0);
  });

  it('is safe to call twice', async () => {
    const started = await serve({ ...migratedVolume(), sourceFrom: 'socket', port: 0 });
    await started.stop();
    // A second signal must not throw on an already-closed database handle.
    await expect(started.stop()).resolves.toBeUndefined();
  });
});
