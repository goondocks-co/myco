import { describe, expect, it } from 'bun:test';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { readSetupIdentity, readSetupProgress } from '@myco-server-worker/read/setup.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { analyzedStore, PROFILES } from './helpers/planner-stats.js';

describe('setup read budget and query plans', () => {
  it('uses five reads for admins and two for members; new reads seek existing indexes on every planner profile', async () => {
    const f = sqliteEnv();
    const statements: Array<{ sql: string; params: unknown[] }> = [];
    const db: RelationalStore = {
      ...f.db,
      prepare(sql) {
        const record = { sql, params: [] as unknown[] }; statements.push(record);
        const wrap = (statement: PreparedStatement): PreparedStatement => ({
          ...statement,
          bind(...params) { record.params = params; return wrap(statement.bind(...params)); },
        });
        return wrap(f.db.prepare(sql));
      },
    };
    const stores = { empty: f.sqlite, current: analyzedStore(PROFILES.current), stale: analyzedStore(PROFILES.stale) };
    try {
      await readSetupProgress({ ...f.serverEnv, db }, { all: true }, 1_790_000_000_000);
      await readSetupIdentity(db, 'mem_machine_1');
      expect(statements).toHaveLength(5);
      const newReads = statements.filter(statement => /AS signed_in|AS owner_linked|AS produced$/.test(statement.sql));
      expect(newReads).toHaveLength(3);
      for (const [profile, sqlite] of Object.entries(stores)) for (const statement of newReads) {
        const steps = (sqlite.query(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.params as never[]) as Array<{ detail: string }>).map(row => row.detail);
        console.info(`setup EXPLAIN ${profile}: ${steps.join(' | ')}`);
        const candidateScans = steps.includes('CO-ROUTINE s') ? ['SCAN s'] : [];
        expect(steps.filter(step => /^SCAN (?!CONSTANT ROW|h(?: EXISTS)? VIRTUAL TABLE INDEX)/.test(step))).toEqual(candidateScans);
        if (statement.sql.includes('AS signed_in')) {
          expect(steps.join(' ')).not.toContain('USE TEMP B-TREE FOR ORDER BY');
          expect(steps.join(' ')).toContain('idx_sessions_harness_live (machine_id=? AND agent=? AND last_live_received_at>?)');
          expect(steps.join(' ')).toContain('idx_member_credentials_machine (machine_id=?)');
          expect(steps.join(' ')).toContain('idx_fleet_queue (status=?)');
        } else if (statement.sql.includes('AS produced')) {
          expect(steps.join(' ')).toContain('idx_agent_runs_retention (resumable=? AND <expr>>? AND <expr><?)');
          expect(steps.join(' ')).toContain('idx_spores_author (project_id=? AND author=?)');
        } else {
          expect(steps.join(' ')).toContain('idx_members_github_id (github_id>?)');
        }
      }
      statements.length = 0;
      await readSetupProgress({ ...f.serverEnv, db }, { all: false, memberId: 'mem_machine_2' }, 1_790_000_000_000);
      await readSetupIdentity(db, 'mem_machine_2');
      expect(statements).toHaveLength(2);
      expect(statements[0]!.sql).toContain('idx_machine_claims_member');
      const steps = (f.sqlite.query(`EXPLAIN QUERY PLAN ${statements[0]!.sql}`).all(...statements[0]!.params as never[]) as Array<{ detail: string }>).map(row => row.detail);
      console.info(`setup EXPLAIN member: ${steps.join(' | ')}`);
      expect(steps.filter(step => /^SCAN (?!CONSTANT ROW|h(?: EXISTS)? VIRTUAL TABLE INDEX)/.test(step))).toEqual(['SCAN s']);
      expect(steps.join(' ')).toContain('idx_sessions_harness_live (machine_id=? AND agent=? AND last_live_received_at>?)');
      expect(statements.every(statement => statement.params.length <= 100)).toBe(true);
    } finally { for (const sqlite of Object.values(stores)) sqlite.close(); }
  });
});
