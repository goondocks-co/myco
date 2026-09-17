/**
 * The owner surface: what admission captures before an export runs, what it refuses, what it wakes, and what a
 * status answer may claim. The producer itself is a stand-in here; its own behaviour is proven in its own suites.
 */
import { expect, it } from 'bun:test';
import { handleRecoveryExportStatus, handleStartRecoveryExport } from '@myco-server-worker/api/recovery.js';
import type { RecoveryAdmission, RecoveryProducerStatus } from '@myco-server-worker/core/recovery-producer.js';
import { sqliteEnv } from './helpers/fixtures.js';

const OWNER = { member: { id: 'owner-1' }, now: 1_000 } as never;

const idle: RecoveryProducerStatus = {
  attempt: null, stage: 'idle', recoverable: false, staged: null, export: null, error: null, transientSpent: 0, stagedSchema: null,
};

function producer() {
  const seen: RecoveryAdmission[] = [];
  let status: RecoveryProducerStatus = idle;
  return {
    seen,
    set: (next: Partial<RecoveryProducerStatus>) => { status = { ...idle, ...next }; },
    port: {
      admit: async (admission: RecoveryAdmission) => { seen.push(admission); status = { ...idle, attempt: 1, stage: 'export' as const }; return status; },
      status: async () => status,
      noteSchemaDrift: async () => { throw new Error('a status read must not mutate an attempt'); },
    },
  };
}

it('captures the schema before any export, names its tables, and wakes the Deployment it admitted on', async () => {
  const env = sqliteEnv();
  const held = producer();
  const wakes: number[] = [];
  const response = await handleStartRecoveryExport(
    { ...env.serverEnv, recovery: held.port, wake: async () => { wakes.push(1); } } as never, OWNER,
  );
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, unknown>;
  expect([body.stage, body.recoverable]).toEqual(['export', false]);
  expect(String(body.usable)).toContain('materializes');
  expect(wakes).toEqual([1]);

  const [admission] = held.seen;
  expect(admission!.tables).toContain('sessions');
  expect(admission!.tables).toContain('sqlite_sequence');
  const captured = JSON.parse(admission!.schema) as Array<{ name: string; type: string; storage: string | null }>;
  expect(captured.some((row) => row.name === 'sessions' && row.type === 'table')).toBe(true);
  expect(captured.some((row) => row.name === 'sessions_fts')).toBe(true);
  // The definitions the export is later held to travel with the admission, taken from the same capture: one
  // definition per ordinary table, and none for an index, a view or a virtual table.
  const definitions = admission!.captured;
  expect(Object.keys(definitions).sort()).toEqual(captured.filter((row) => row.storage === 'table').map((row) => row.name).sort());
  expect(definitions.sessions).toContain('CREATE TABLE');
  env.sqlite.close();
});

it('refuses a schema this recovery cannot reconstruct, before an export pauses anything', async () => {
  const env = sqliteEnv();
  env.sqlite.exec("CREATE VIRTUAL TABLE opaque_fts USING fts5(body)");
  const held = producer();
  const response = await handleStartRecoveryExport({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  expect(response.status).toBe(400);
  expect(String((await response.json() as { reason?: string }).reason)).toContain('cannot reconstruct virtual table opaque_fts');
  expect(held.seen).toEqual([]);
  env.sqlite.close();
});

it('says plainly that a Deployment with no producer runs none', async () => {
  const env = sqliteEnv();
  for (const handler of [handleStartRecoveryExport, handleRecoveryExportStatus]) {
    const response = await handler({ ...env.serverEnv, recovery: undefined } as never, OWNER);
    expect(response.status).toBe(400);
    expect(String((await response.json() as { reason?: string }).reason)).toContain('runs no hosted recovery producer');
  }
  env.sqlite.close();
});

it('reads a status without touching the attempt or claiming recoverability', async () => {
  const env = sqliteEnv();
  const held = producer();
  held.set({ attempt: 2, stage: 'complete', staged: { prefix: 'staging/2', sqlBytes: 8, downloadedBytes: 8, parts: 2, objects: { registered: 3, staged: 3 } }, stagedSchema: { sha256: 'a'.repeat(64), bytes: 10 } });
  const response = await handleRecoveryExportStatus({ ...env.serverEnv, recovery: held.port } as never, OWNER);
  const body = await response.json() as Record<string, unknown>;
  // A complete staging is still not a recoverable artifact: only a materialized and verified one is.
  expect([body.stage, body.recoverable]).toEqual(['complete', false]);
  expect(String(body.usable)).toContain('a complete staging is not yet one');
  env.sqlite.close();
});
