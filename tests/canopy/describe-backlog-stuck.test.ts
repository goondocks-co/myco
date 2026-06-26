import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { CANOPY_ENTRIES_TABLE } from '@myco/db/schema-ddl.js';
import { getCanopyDescribeBacklog } from '@myco/db/queries/canopy.js';
import { seedCanopyEntry } from '../helpers/db.js';
import { projectScope } from '@myco/grove/ids.js';

describe('getCanopyDescribeBacklog stuck bucket', () => {
  test('attempt-capped rows count as stuck, not pending', () => {
    const db = new Database(':memory:');
    db.prepare(CANOPY_ENTRIES_TABLE).run();
    seedCanopyEntry(db, { project_id: 'p', path: 'eligible.ts', llm_description: null });
    seedCanopyEntry(db, { project_id: 'p', path: 'stuck.ts', llm_description: null });
    db.exec("UPDATE canopy_entries SET describe_attempts = 2 WHERE path = 'stuck.ts'");
    const b = getCanopyDescribeBacklog(db, projectScope('p'), { maxAttempts: 2 });
    expect(b.pending).toBe(1);   // eligible only
    expect(b.stuck).toBe(1);     // capped row surfaced, not hidden
  });
});
