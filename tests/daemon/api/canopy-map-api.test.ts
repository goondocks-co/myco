/**
 * Tests for the /canopy/map daemon HTTP handlers (get, regenerate).
 *
 * The handlers are pure functions over a plain args object — same pattern as
 * canopy-entries-api.test.ts. handleCanopyMapRegenerate accepts an injectable
 * runner so tests don't need to stand up the full agent executor; the route
 * registration in canopy-read.ts wires the real runner.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import {
  handleCanopyMapGet,
  handleCanopyMapRegenerate,
} from '@myco/daemon/api/canopy-read.js';
import { writeCanopyMap } from '@myco/canopy/map/store.js';

const PROJECT_ID = '/repo/myco';
const MACHINE_ID = 'local';

describe('handleCanopyMapGet', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns the empty-state envelope when no row exists', async () => {
    const res = await handleCanopyMapGet({ project_id: PROJECT_ID, machine_id: MACHINE_ID });
    expect(res.is_empty).toBe(true);
    expect(res.content).toBe('');
    expect(typeof res.message).toBe('string');
  });

  it('returns the row when present', async () => {
    writeCanopyMap({
      project_id: PROJECT_ID,
      machine_id: MACHINE_ID,
      content: '## map',
      inputs_hash: 'h',
      token_estimate: 100,
      generated_by_run_id: null,
    });
    const res = await handleCanopyMapGet({ project_id: PROJECT_ID, machine_id: MACHINE_ID });
    expect(res.content).toBe('## map');
    expect(res.token_estimate).toBe(100);
    expect(res.inputs_hash).toBe('h');
    expect(res.is_empty).toBeUndefined();
  });

  it('scopes by (project_id, machine_id) — does not leak other rows', async () => {
    writeCanopyMap({
      project_id: '/repo/other',
      machine_id: MACHINE_ID,
      content: '## other',
      inputs_hash: 'x',
      token_estimate: 1,
      generated_by_run_id: null,
    });
    const res = await handleCanopyMapGet({ project_id: PROJECT_ID, machine_id: MACHINE_ID });
    expect(res.is_empty).toBe(true);
  });
});

describe('handleCanopyMapRegenerate', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('enqueues a canopy-map run and returns ok with run id', async () => {
    const calls: Array<{ task: string; params: Record<string, unknown> | undefined }> = [];
    const res = await handleCanopyMapRegenerate(
      { project_id: PROJECT_ID, machine_id: MACHINE_ID, force_cold_start: false },
      {
        runner: async ({ task, params }) => {
          calls.push({ task, params });
          return { run_id: 'run-abc' };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.run_id).toBe('run-abc');
    expect(calls).toHaveLength(1);
    expect(calls[0].task).toBe('canopy-map');
    expect(calls[0].params?.force_cold_start).toBe(false);
  });

  it('passes force_cold_start through to the task params', async () => {
    const calls: Array<{ task: string; params: Record<string, unknown> | undefined }> = [];
    const res = await handleCanopyMapRegenerate(
      { project_id: PROJECT_ID, machine_id: MACHINE_ID, force_cold_start: true },
      {
        runner: async ({ task, params }) => {
          calls.push({ task, params });
          return { run_id: 'run-xyz' };
        },
      },
    );
    expect(res.ok).toBe(true);
    expect(res.run_id).toBe('run-xyz');
    expect(calls[0].params?.force_cold_start).toBe(true);
  });
});
