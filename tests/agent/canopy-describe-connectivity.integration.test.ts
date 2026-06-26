/**
 * Run-level integration tests for the canopy-describe map phase, closing the
 * review's two connectivity coverage gaps by driving the REAL executor
 * (`runAgent`) end to end — not `executeMapPhase` in isolation.
 *
 * Exercises the full chain:
 *   runAgent -> resolveRunConfig(canopy-describe.yaml) -> executePhasedQuery
 *   -> runMapPhaseAdapter -> executeMapPhase -> real canopy_describe_next /
 *   canopy_describe_write / canopy_describe_charge tools -> in-memory SQLite
 *   vault -> injected harness -> persisted run status.
 *
 * The harness is injected at the run level via the harness registry
 * (`registerAgentHarness`) + `executionOverrides.harness`, because the
 * executor's public run API does NOT surface `ExecuteMapPhaseInput.probeAvailable`
 * (runMapPhaseAdapter never forwards it). A connection-throwing harness is the
 * wireable way to reproduce a provider outage through the genuine run; a
 * sink-rejecting harness reproduces an all-content-failed batch. No real
 * provider is configured, so the in-map health probe (`probeProviderAvailable`)
 * treats the run as cloud/unknown and returns reachable — letting the injected
 * harness, not a network probe, drive each scenario deterministically.
 *
 * Uses bun:test + bun:sqlite + seedCanopyEntry to match the canopy test
 * conventions (the DB-touching agent tests in this package use bun:test).
 */

import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { epochSeconds } from '@myco/constants.js';
import { runAgent } from '@myco/agent/executor.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { STATUS_COMPLETED, STATUS_FAILED } from '@myco/db/queries/runs.js';
import {
  registerAgentHarness,
  listAgentHarnessIds,
} from '@myco/agent/harness/index.js';
import { HarnessExecutionError } from '@myco/agent/harness/types.js';
import { ensureProjectManifest } from '@myco/config/project-manifest.js';
import { seedCanopyEntry } from '../helpers/db';
import { makeTestRequestContext } from '../helpers/request-context';

// ---------------------------------------------------------------------------
// Injected harness
// ---------------------------------------------------------------------------

// A single fake harness id registered once for this file. Its factory returns
// an object that delegates `execute` to a per-test mutable function, so each
// scenario installs its own behavior (connection-throw vs sink-reject) before
// calling runAgent. No `openScope`, so executeMapPhase uses the per-item
// `execute()` path (matching makeStubRuntime in the sibling integration test).
const FAKE_HARNESS_ID = 'test-connectivity-harness';

let activeExecute: (input: any) => Promise<any> = async () => {
  throw new Error('activeExecute not installed by test');
};

if (!listAgentHarnessIds().includes(FAKE_HARNESS_ID)) {
  registerAgentHarness(FAKE_HARNESS_ID, () => ({
    id: FAKE_HARNESS_ID,
    supports: () => false,
    execute: (input: any) => activeExecute(input),
  }) as any);
}

/** Harness that fails every item with a connection-class error (provider outage). */
const connectionDownExecute = async () => {
  throw new HarnessExecutionError('Was there a typo in the url or port?', {
    usage: {},
    kind: 'connection',
  });
};

/**
 * Harness that SUCCEEDS (the model ran) but drives the sink to a non-ok write:
 * an empty description trips canopy_describe_write's `empty` content-gate, so
 * every item is a genuine content failure (kind !== 'connection').
 */
const contentFailExecute = async (input: any) => {
  const sink = input.toolSurface?.tools?.find(
    (t: any) => t.name === 'canopy_describe_write',
  );
  if (sink) await sink.handler({ description: '' });
  return { finalText: '', turnsUsed: 1, usage: {} };
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('canopy-describe connectivity (run-level via runAgent)', () => {
  let projectRoot: string;
  let vaultDir: string;
  let projectId: string;

  beforeAll(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-conn-itest-'));
    vaultDir = path.join(projectRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    const manifest = ensureProjectManifest(vaultDir, { projectName: 'canopy-conn-itest' });
    projectId = manifest.project.id;
  });

  afterAll(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  function freshDb() {
    closeDatabase();
    const db = initDatabase(':memory:');
    createSchema(db);
    // agent_runs.agent_id FKs into agents; the executor inserts a run row.
    const now = epochSeconds();
    registerAgent({ id: 'myco-agent', name: 'Myco Agent', created_at: now, updated_at: now });
    return db;
  }

  function seedPending(db: ReturnType<typeof freshDb>, paths: string[]) {
    for (const p of paths) {
      // describe_attempts defaults to 0; llm_description NULL => pending.
      seedCanopyEntry(db, { project_id: projectId, path: p, mechanical_updated_at: 100 });
    }
  }

  function runOptions() {
    return {
      task: 'canopy-describe',
      requestContext: makeTestRequestContext({ projectId, vaultDir }),
      executionOverrides: { harness: FAKE_HARNESS_ID },
    } as const;
  }

  it('provider-down → run COMPLETES (required phase skipped), attempts UNCHANGED', async () => {
    const db = freshDb();
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    seedPending(db, paths);

    activeExecute = connectionDownExecute;
    const result = await runAgent(vaultDir, runOptions());

    // A provider outage with no writes resolves the required `describe` map
    // phase to `skipped` (mapResultToPhaseStatus), and a skipped required
    // phase does NOT fail the run — so the run COMPLETES.
    expect(result.status).toBe(STATUS_COMPLETED);
    const describePhase = result.phases?.find((p) => p.name === 'describe');
    expect(describePhase?.status).toBe('skipped');

    // No charge for an outage: every row's describe_attempts is still 0.
    const rows = db
      .prepare('SELECT path, describe_attempts FROM canopy_entries WHERE project_id = ? ORDER BY path')
      .all(projectId) as { path: string; describe_attempts: number }[];
    expect(rows.map((r) => r.path)).toEqual(paths);
    for (const row of rows) {
      expect(row.describe_attempts).toBe(0);
    }
  });

  it('all-content-failed batch → attempts INCREMENT by 1, phase FAILS, run FAILS', async () => {
    const db = freshDb();
    const paths = ['a.ts', 'b.ts', 'c.ts'];
    seedPending(db, paths);

    activeExecute = contentFailExecute;
    const result = await runAgent(vaultDir, runOptions());

    // Items were fetched, the model ran, but nothing was written and there was
    // no provider outage → the `describe` phase is `failed`
    // (mapResultToPhaseStatus: itemCount>0, written=0, no outage). `describe`
    // is required, so the run surfaces failed.
    expect(result.status).toBe(STATUS_FAILED);
    const describePhase = result.phases?.find((p) => p.name === 'describe');
    expect(describePhase?.status).toBe('failed');

    // The A7 accounting charge flush burns exactly one attempt per content-
    // failed/skip item.
    const rows = db
      .prepare('SELECT path, describe_attempts FROM canopy_entries WHERE project_id = ? ORDER BY path')
      .all(projectId) as { path: string; describe_attempts: number }[];
    expect(rows.map((r) => r.path)).toEqual(paths);
    for (const row of rows) {
      expect(row.describe_attempts).toBe(1);
    }
  });
});
