/**
 * Tests for the myco_cortex Canopy map helper.
 *
 * Direct DB access — the handler reads `canopy_maps` via the store.
 *
 * The per-session canopy_map call counter previously lived on a dispatch-time
 * `incrementCanopyMapToolCalls` helper. That counter has been retired in
 * favor of `aggregateSessionMycoToolCalls`, which derives per-(tool, op)
 * counts at Stop boundary from the `activities` log (see
 * `tests/db/myco-tool-usage.test.ts` for the new coverage).
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { handleCanopyMap } from '@myco/tools/canopy-map.js';
import { writeCanopyMap } from '@myco/canopy/map/store.js';

beforeEach(() => { setupTestDb(); cleanTestDb(); });
afterEach(() => teardownTestDb());

describe('myco_cortex op: canopy_map helper', () => {
  it('returns empty-state shape when no map exists', async () => {
    const res = await handleCanopyMap({ projectId: 'p', machineId: 'local' });
    expect(res.is_empty).toBe(true);
    expect(res.content).toBe('');
    expect(res.message).toBeDefined();
  });

  it('returns content + metadata when a map exists', async () => {
    writeCanopyMap({
      project_id: 'p', machine_id: 'local', content: '## map',
      inputs_hash: 'h', token_estimate: 250, generated_by_run_id: null,
    });
    const res = await handleCanopyMap({ projectId: 'p', machineId: 'local' });
    expect(res.content).toBe('## map');
    expect(res.token_estimate).toBe(250);
    expect(res.is_empty).toBeUndefined();
    expect(res.generated_at).toBeGreaterThan(0);
  });
});
