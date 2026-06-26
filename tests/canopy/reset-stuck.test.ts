import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CANOPY_ENTRIES_TABLE } from '@myco/db/schema-ddl.js';
import { resetStuckDescribeAttempts, getCanopyDescribeBacklog } from '@myco/db/queries/canopy.js';
import { seedCanopyEntry } from '../helpers/db.js';
import { projectScope, ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

describe('resetStuckDescribeAttempts', () => {
  test('reset re-eligibilizes stuck rows', () => {
    const db = new Database(':memory:');
    db.prepare(CANOPY_ENTRIES_TABLE).run();
    seedCanopyEntry(db, { project_id: 'p', path: 'stuck.ts', llm_description: null });
    db.exec("UPDATE canopy_entries SET describe_attempts = 2 WHERE path = 'stuck.ts'");
    const n = resetStuckDescribeAttempts(db, projectScope('p'), { maxAttempts: 2 });
    expect(n).toBe(1);
    const b = getCanopyDescribeBacklog(db, projectScope('p'), { maxAttempts: 2 });
    expect(b.pending).toBe(1);
    expect(b.stuck).toBe(0);
  });

  test('projectIds restrict excludes stuck rows from non-matching project', () => {
    const db = new Database(':memory:');
    db.prepare(CANOPY_ENTRIES_TABLE).run();
    // 'p' is the active scope; seed a stuck row for orphaned project 'orphan'
    seedCanopyEntry(db, { project_id: 'p', path: 'active.ts', llm_description: null });
    seedCanopyEntry(db, { project_id: 'orphan', path: 'orphan.ts', llm_description: null });
    db.exec("UPDATE canopy_entries SET describe_attempts = 2 WHERE path = 'active.ts'");
    db.exec("UPDATE canopy_entries SET describe_attempts = 2 WHERE path = 'orphan.ts'");
    // Grove-wide scope ('all'), restrict to only serviceable project 'p'
    const n = resetStuckDescribeAttempts(db, ALL_PROJECTS_SCOPE, { maxAttempts: 2, projectIds: ['p'] });
    expect(n).toBe(1); // only 'p' row reset; orphan row left untouched
    const orphanAttempts = (db.prepare(
      "SELECT describe_attempts FROM canopy_entries WHERE path = 'orphan.ts'",
    ).get() as { describe_attempts: number }).describe_attempts;
    expect(orphanAttempts).toBe(2); // not reset
  });
});
