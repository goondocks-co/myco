/**
 * The skill lifecycle server-side, and the properties 1.4 encodes.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  CANDIDATE_IMMUTABLE_COLUMNS, CANDIDATE_UPDATE_COLUMNS, deleteSkillRecordCascade,
  getCandidate, getPublishedSkillContent, getSkillContentAtGeneration, getSkillRecord,
  insertCandidate, insertLineage, insertSkillRecord, listLineageForSkill, listSkillRecords,
  recordSkillUsage, updateCandidate,
} from '@myco-server-worker/core/skills.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const OTHER: ReadScope = { projectId: 'proj_two' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  for (const p of [SCOPE.projectId, OTHER.projectId]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

const record = (id: string, name: string, candidateId: string | null = null) => ({
  id, agentId: AGENT, name, displayName: name, description: 'd',
  candidateId, sourceIds: '[]', path: `.agents/skills/${name}/SKILL.md`, createdAt: NOW,
});
const candidate = (id: string) => ({ id, agentId: AGENT, topic: 't', rationale: 'r', confidence: 0.5, sourceIds: '[]', createdAt: NOW });
const lineage = (id: string, skillId: string, generation: number, content: string) => ({
  id, skillId, generation, action: 'generate', rationale: 'r', sourceIdsAdded: '[]',
  contentSnapshot: content, createdAt: NOW + generation,
});

describe('skill records', () => {
  it('finds a record by id or by name, and prefers the id when a name collides with one', async () => {
    const { db } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    expect((await getSkillRecord(db, SCOPE, 'sk1') as { name: string }).name).toBe('debugging');
    expect((await getSkillRecord(db, SCOPE, 'debugging') as { id: string }).id).toBe('sk1');
    expect(await getSkillRecord(db, OTHER, 'sk1')).toBeNull();
  });

  it('lets two Projects each hold a skill of the same name', async () => {
    const { db } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertSkillRecord(db, OTHER, record('sk2', 'debugging'));
    expect((await listSkillRecords(db, SCOPE)).length).toBe(1);
    expect((await listSkillRecords(db, OTHER)).length).toBe(1);
  });

  it('counts a use without losing a concurrent one', async () => {
    const { db, sqlite } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await Promise.all([
      recordSkillUsage(db, SCOPE, { id: 'u1', skillId: 'sk1', sessionId: 's1', detectedAt: NOW }),
      recordSkillUsage(db, SCOPE, { id: 'u2', skillId: 'sk1', sessionId: 's2', detectedAt: NOW }),
    ]);
    expect((sqlite.query(`SELECT usage_count c FROM skill_records WHERE id = 'sk1'`).get() as { c: number }).c).toBe(2);
  });
});

describe('lineage is the source of a skill content', () => {
  it('answers the latest generation snapshot', async () => {
    const { db } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'first'));
    await insertLineage(db, SCOPE, lineage('l2', 'sk1', 2, 'second'));
    expect(await getPublishedSkillContent(db, SCOPE, 'sk1')).toBe('second');
    expect((await listLineageForSkill(db, SCOPE, 'sk1') as { generation: number }[]).map((r) => r.generation)).toEqual([2, 1]);
  });

  it('answers a pinned generation rather than the latest', async () => {
    const { db } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'first'));
    await insertLineage(db, SCOPE, lineage('l2', 'sk1', 2, 'second'));
    expect(await getSkillContentAtGeneration(db, SCOPE, 'sk1', 1)).toBe('first');
    expect(await getSkillContentAtGeneration(db, SCOPE, 'sk1', 9)).toBeNull();
  });

  it('reads content within the Project, which the server can do and 1.4 cannot', async () => {
    const { db } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'mine'));
    expect(await getPublishedSkillContent(db, OTHER, 'sk1')).toBeNull();
  });
});

describe('candidate approval', () => {
  it('stamps approved_at on the first approval and never moves it', async () => {
    const { db } = store();
    await insertCandidate(db, SCOPE, candidate('c1'));
    await updateCandidate(db, SCOPE, 'c1', { status: 'approved' }, NOW + 10);
    const first = (await getCandidate(db, SCOPE, 'c1') as { approvedAt: number }).approvedAt;
    expect(first).toBe(NOW + 10);

    await updateCandidate(db, SCOPE, 'c1', { status: 'approved' }, NOW + 999);
    expect((await getCandidate(db, SCOPE, 'c1') as { approvedAt: number }).approvedAt).toBe(first);
  });

  it('leaves approved_at unset while a candidate has never been approved', async () => {
    const { db } = store();
    await insertCandidate(db, SCOPE, candidate('c1'));
    await updateCandidate(db, SCOPE, 'c1', { status: 'dismissed' }, NOW + 10);
    expect((await getCandidate(db, SCOPE, 'c1') as { approvedAt: number | null }).approvedAt).toBeNull();
  });

  it('never lets an update move a candidate between Projects or rewrite its stamp', () => {
    for (const column of CANDIDATE_IMMUTABLE_COLUMNS) {
      expect({ column, settable: (CANDIDATE_UPDATE_COLUMNS as readonly string[]).includes(column) })
        .toEqual({ column, settable: false });
    }
  });

  it('reports zero for a candidate outside the scope', async () => {
    const { db } = store();
    await insertCandidate(db, SCOPE, candidate('c1'));
    expect(await updateCandidate(db, OTHER, 'c1', { status: 'approved' }, NOW)).toBe(0);
  });
});

describe('deleting a skill', () => {
  it('dismisses the candidate that generated it, so the next survey does not regenerate it', async () => {
    const { db, sqlite } = store();
    await insertCandidate(db, SCOPE, candidate('c1'));
    await updateCandidate(db, SCOPE, 'c1', { status: 'approved', skill_id: 'sk1' }, NOW);
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging', 'c1'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'body'));

    expect(await deleteSkillRecordCascade(db, SCOPE, 'sk1', NOW + 5)).toBe(true);
    const c = sqlite.query(`SELECT status, skill_id AS s FROM skill_candidates WHERE id = 'c1'`).get() as { status: string; s: string | null };
    expect(c).toEqual({ status: 'dismissed', s: null });
  });

  it('removes the lineage and usage with the record, leaving nothing orphaned', async () => {
    const { db, sqlite } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'body'));
    await recordSkillUsage(db, SCOPE, { id: 'u1', skillId: 'sk1', sessionId: 's1', detectedAt: NOW });

    await deleteSkillRecordCascade(db, SCOPE, 'sk1', NOW + 5);
    const counts = sqlite.query(`SELECT
      (SELECT COUNT(*) FROM skill_records) r,
      (SELECT COUNT(*) FROM skill_lineage) l,
      (SELECT COUNT(*) FROM skill_usage) u`).get();
    expect(counts).toEqual({ r: 0, l: 0, u: 0 });
  });

  it('touches nothing in another Project', async () => {
    const { db, sqlite } = store();
    await insertSkillRecord(db, SCOPE, record('sk1', 'debugging'));
    await insertLineage(db, SCOPE, lineage('l1', 'sk1', 1, 'body'));
    expect(await deleteSkillRecordCascade(db, OTHER, 'sk1', NOW + 5)).toBe(false);
    expect((sqlite.query(`SELECT COUNT(*) c FROM skill_lineage`).get() as { c: number }).c).toBe(1);
  });
});
