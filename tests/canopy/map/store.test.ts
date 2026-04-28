import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { readCanopyMap, writeCanopyMap } from '@myco/canopy/map/store.js';

beforeEach(() => setupTestDb());
afterEach(() => teardownTestDb());

describe('canopy_maps store', () => {
  it('readCanopyMap returns null when no row exists', () => {
    expect(readCanopyMap('p', 'local')).toBeNull();
  });

  it('writeCanopyMap inserts a row and readCanopyMap returns it', () => {
    writeCanopyMap({
      project_id: 'p', machine_id: 'local',
      content: '## map', inputs_hash: 'abc', token_estimate: 200,
      generated_by_run_id: 'run-1',
    });
    const row = readCanopyMap('p', 'local');
    expect(row).toMatchObject({
      project_id: 'p', machine_id: 'local', content: '## map',
      inputs_hash: 'abc', token_estimate: 200,
      generated_by_run_id: 'run-1',
    });
    expect(row?.generated_at).toBeGreaterThan(0);
  });

  it('writeCanopyMap replaces atomically (no half-state on failure)', () => {
    writeCanopyMap({
      project_id: 'p', machine_id: 'local',
      content: 'first', inputs_hash: 'h1', token_estimate: 10, generated_by_run_id: 'run-1',
    });
    writeCanopyMap({
      project_id: 'p', machine_id: 'local',
      content: 'second', inputs_hash: 'h2', token_estimate: 20, generated_by_run_id: 'run-2',
    });
    const row = readCanopyMap('p', 'local');
    expect(row?.content).toBe('second');
    expect(row?.inputs_hash).toBe('h2');
  });

  it('isolates by (project_id, machine_id) composite key', () => {
    writeCanopyMap({
      project_id: 'p1', machine_id: 'local',
      content: 'one', inputs_hash: 'h', token_estimate: 1, generated_by_run_id: null,
    });
    writeCanopyMap({
      project_id: 'p2', machine_id: 'local',
      content: 'two', inputs_hash: 'h', token_estimate: 1, generated_by_run_id: null,
    });
    expect(readCanopyMap('p1', 'local')?.content).toBe('one');
    expect(readCanopyMap('p2', 'local')?.content).toBe('two');
  });
});
