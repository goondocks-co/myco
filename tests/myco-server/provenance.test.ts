/**
 * Release state reads: the bulk lookup, and the namespace guard.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  getReleaseState, getReleaseStatesForRecords, isReleaseNamespace, listReleaseStates,
} from '@myco-server-worker/core/provenance.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const NOW = 1_700_000_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

function seed(sqlite: Database, projectId: string, id: string, namespace: string, recordId: string, state = 'released'): void {
  sqlite.query(`INSERT INTO knowledge_release_state
    (project_id, id, identity_key, namespace, record_id, state, confidence, checked_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'high', ?, ?)`)
    .run(projectId, id, `${projectId}:${namespace}:${recordId}`, namespace, recordId, state, NOW, NOW);
}

describe('release state', () => {
  it('reads one record within its Project', async () => {
    const { db, sqlite } = store();
    seed(sqlite, SCOPE.projectId, 'rs1', 'spore', 'sp1');
    expect((await getReleaseState(db, SCOPE, 'spore', 'sp1'))?.state).toBe('released');
    expect(await getReleaseState(db, OTHER, 'spore', 'sp1')).toBeNull();
  });

  it('answers many records in one query, absent ids simply missing', async () => {
    const { db, sqlite } = store();
    seed(sqlite, SCOPE.projectId, 'rs1', 'spore', 'sp1');
    seed(sqlite, SCOPE.projectId, 'rs2', 'spore', 'sp2', 'unreleased');
    const map = await getReleaseStatesForRecords(db, SCOPE, 'spore', ['sp1', 'sp2', 'sp_absent']);
    expect(Object.keys(map).sort()).toEqual(['sp1', 'sp2']);
    expect(map.sp2.state).toBe('unreleased');
  });

  it('answers an empty request without querying at all', async () => {
    const { db } = store();
    expect(await getReleaseStatesForRecords(db, SCOPE, 'spore', [])).toEqual({});
  });

  it('de-duplicates repeated ids rather than widening the query', async () => {
    const { db, sqlite } = store();
    seed(sqlite, SCOPE.projectId, 'rs1', 'spore', 'sp1');
    const map = await getReleaseStatesForRecords(db, SCOPE, 'spore', ['sp1', 'sp1', 'sp1']);
    expect(Object.keys(map)).toEqual(['sp1']);
  });

  it('keeps namespaces apart, so a skill id does not answer for a spore', async () => {
    const { db, sqlite } = store();
    seed(sqlite, SCOPE.projectId, 'rs1', 'skill', 'shared_id');
    expect(await getReleaseState(db, SCOPE, 'spore', 'shared_id')).toBeNull();
    expect(await getReleaseState(db, SCOPE, 'skill', 'shared_id')).not.toBeNull();
  });

  it('answers no record of another Project in a bulk lookup', async () => {
    const { db, sqlite } = store();
    seed(sqlite, OTHER.projectId, 'rs1', 'spore', 'sp1');
    expect(await getReleaseStatesForRecords(db, SCOPE, 'spore', ['sp1'])).toEqual({});
  });

  it('names the known namespaces, so an unknown one is refused rather than read as unreleased', () => {
    expect(isReleaseNamespace('spore')).toBe(true);
    expect(isReleaseNamespace('sporez')).toBe(false);
    expect(isReleaseNamespace(undefined)).toBe(false);
  });

  it('lists by namespace and state within the Project', async () => {
    const { db, sqlite } = store();
    seed(sqlite, SCOPE.projectId, 'rs1', 'spore', 'sp1', 'released');
    seed(sqlite, SCOPE.projectId, 'rs2', 'skill', 'sk1', 'released');
    seed(sqlite, OTHER.projectId, 'rs3', 'spore', 'sp9', 'released');
    expect((await listReleaseStates(db, SCOPE, { namespace: 'spore' })).map((r) => r.recordId)).toEqual(['sp1']);
    expect((await listReleaseStates(db, SCOPE)).length).toBe(2);
  });
});
