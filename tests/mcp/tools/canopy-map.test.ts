/**
 * Tests for myco_cortex Canopy map helper + sessions counter helper.
 *
 * Direct DB access helper — the handler reads canopy_maps via the store and
 * the counter helper increments sessions.canopy_map_tool_calls.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { handleCanopyMap } from '@myco/tools/canopy-map.js';
import { writeCanopyMap } from '@myco/canopy/map/store.js';
import { incrementCanopyMapToolCalls } from '@myco/db/queries/sessions.js';
import { getDatabase } from '@myco/db/client.js';
import { seedSession } from '../../helpers/sessions.js';

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

  it('increments sessions.canopy_map_tool_calls', () => {
    const db = getDatabase();
    seedSession({ id: 's1' });
    incrementCanopyMapToolCalls('s1');
    incrementCanopyMapToolCalls('s1');
    const row = db.prepare(
      `SELECT canopy_map_tool_calls AS n FROM sessions WHERE id = 's1'`,
    ).get() as { n: number };
    expect(row.n).toBe(2);
  });

  it('incrementCanopyMapToolCalls is a no-op for unknown session', () => {
    expect(() => incrementCanopyMapToolCalls('nope')).not.toThrow();
  });
});
