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
