import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { withDatabase } from '@myco/db/client';
import { CANOPY_ENTRIES_TABLE } from '@myco/db/schema-ddl';
import { ALL_PROJECTS_SCOPE, projectScope } from '@myco/grove/ids';
import {
  archiveProjectInGrove,
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry';
import { createCanopyDescribeBacklogReader } from '@myco/canopy/describe-backlog';
import { getCanopyDescribeBacklog } from '@myco/db/queries/canopy';

let home: string;
let db: Database;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-describe-backlog-'));
  clearGroveRegistryCaches();
  db = new Database(':memory:');
  db.prepare(CANOPY_ENTRIES_TABLE).run();
});

afterEach(() => {
  db.close();
  fs.rmSync(home, { recursive: true, force: true });
});

function insertUndescribedEntry(projectId: string, filePath: string): void {
  db.prepare(
    `INSERT INTO canopy_entries (
      project_id, path, content_hash, size_bytes, token_estimate,
      line_count, mechanical_updated_at, llm_description, llm_updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(projectId, filePath, `hash-${filePath}`, 10, 5, 1, 200, null, null);
}

describe('canopy describe backlog reader', () => {
  it('grove-wide reads count only active registered projects', () => {
    const grove = createGrove('Test Grove', home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_active',
      projectName: 'active',
      projectRoot: '/tmp/active',
      bindingId: 'gbind_active',
    }, home);
    registerProjectInGrove(grove.id, {
      projectId: 'proj_archived',
      projectName: 'archived',
      projectRoot: '/tmp/archived',
      bindingId: 'gbind_archived',
    }, home);
    archiveProjectInGrove(grove.id, 'proj_archived', home);

    insertUndescribedEntry('proj_active', 'a.ts');
    insertUndescribedEntry('proj_active', 'b.ts');
    insertUndescribedEntry('proj_archived', 'c.ts');
    insertUndescribedEntry('proj_deleted_orphan', 'd.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: grove.id }),
    );

    expect(backlog).toEqual({ pending: 2, undescribed: 2, stale: 0 });
  });

  it('falls back to the unrestricted count when the grove record is unknown', () => {
    insertUndescribedEntry('proj_anything', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(ALL_PROJECTS_SCOPE, { groveId: 'grove_missing' }),
    );

    expect(backlog.undescribed).toBe(1);
  });

  it('project-scoped reads stay unrestricted by the registry', () => {
    insertUndescribedEntry('proj_unregistered', 'a.ts');

    const reader = createCanopyDescribeBacklogReader({ mycoHome: home });
    const backlog = withDatabase(db, () =>
      reader.read(projectScope('proj_unregistered'), { groveId: null }),
    );

    expect(backlog.undescribed).toBe(1);
  });
});

describe('getCanopyDescribeBacklog — describe_attempts budget', () => {
  function insertStaleEntry(projectId: string, filePath: string): void {
    db.prepare(
      `INSERT INTO canopy_entries (
        project_id, path, content_hash, size_bytes, token_estimate,
        line_count, mechanical_updated_at, llm_description, llm_updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(projectId, filePath, `hash-${filePath}`, 10, 5, 1, 200, 'old description', 100);
  }

  it('excludes capped rows from every bucket — no phantom backlog from a poisoned tail', () => {
    insertUndescribedEntry('proj_a', 'fresh.ts');
    insertUndescribedEntry('proj_a', 'poisoned.ts');
    insertStaleEntry('proj_a', 'stale-poisoned.ts');
    db.prepare(
      `UPDATE canopy_entries SET describe_attempts = 2 WHERE path IN ('poisoned.ts', 'stale-poisoned.ts')`,
    ).run();

    const backlog = getCanopyDescribeBacklog(db, projectScope('proj_a'));
    expect(backlog).toEqual({ pending: 1, undescribed: 1, stale: 0 });
  });

  it('reports zero against a fully-poisoned tail, matching the scheduler count', () => {
    insertUndescribedEntry('proj_a', 'a.ts');
    insertStaleEntry('proj_a', 'b.ts');
    db.prepare('UPDATE canopy_entries SET describe_attempts = 2').run();

    expect(getCanopyDescribeBacklog(db, projectScope('proj_a')))
      .toEqual({ pending: 0, undescribed: 0, stale: 0 });
  });

  it('honors a larger per-project maxAttempts', () => {
    insertUndescribedEntry('proj_a', 'a.ts');
    insertStaleEntry('proj_a', 'b.ts');
    db.prepare('UPDATE canopy_entries SET describe_attempts = 2').run();

    expect(getCanopyDescribeBacklog(db, projectScope('proj_a'), { maxAttempts: 4 }))
      .toEqual({ pending: 2, undescribed: 1, stale: 1 });
  });
});
