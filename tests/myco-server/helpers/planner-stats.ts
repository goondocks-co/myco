/**
 * A migrated store holding the planner statistics a Deployment's store holds, for query-plan tests.
 *
 * SQLite plans from `sqlite_stat1` when it has rows, and from fixed guesses when it has none. An empty test store
 * has none, so a plan asserted there is the plan of a Deployment that never ran `ANALYZE`, and a hosted store that
 * has run it plans differently. Each profile here fills the store with rows shaped like a Deployment's —
 * Projects of uneven size, a few machines and agents, spores mostly written by runs, runs mostly the search index's
 * own upkeep, each other run reading one session or a page's handful — and runs `ANALYZE` over them, so the
 * statistics are ones SQLite itself computed.
 *
 * - `current` is a Deployment in use, analyzed with every index of the schema present.
 * - `stale` is the statistics of a hosted store last analyzed while small (3 Projects, 159 sessions,
 *   268 spores), and none for the indexes and the `run_reads` key added after it: a store a later migration
 *   indexed and nothing analyzed again.
 */
import { Database } from 'bun:sqlite';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';

export interface StatsProfile {
  projects: number;
  sessions: number;
  spores: number;
  plans: number;
  runs: number;
  transcripts: number;
  /** Indexes whose statistics the store does not hold. */
  unanalyzed: readonly string[];
}

/** The indexes schema step 57 adds; a store analyzed before it holds no statistics for them. */
export const STEP_57_INDEXES = ['idx_sessions_occurred_deployment', 'idx_spores_created_deployment', 'idx_plans_updated_deployment', 'idx_spores_author', 'idx_sessions_capture'] as const;
/** The indexes schema step 58 adds, the `run_reads` key among them. */
export const STEP_58_INDEXES = ['sqlite_autoindex_run_reads_1', 'idx_run_reads_session', 'idx_spores_session'] as const;

export const PROFILES: Readonly<Record<'current' | 'stale', StatsProfile>> = {
  current: { projects: 13, sessions: 4_000, spores: 2_000, plans: 450, runs: 12_000, transcripts: 4_200, unanalyzed: [] },
  stale: { projects: 3, sessions: 159, spores: 268, plans: 60, runs: 900, transcripts: 170, unanalyzed: [...STEP_57_INDEXES, ...STEP_58_INDEXES] },
};

const AGENTS = ['claude-code', 'claude-code', 'claude-code', 'codex', 'codex', 'cursor', 'pi'];
const TYPES = ['gotcha', 'decision', 'discovery', 'bug_fix', 'trade_off', 'pattern', 'wisdom'];
const TASKS = ['embedding-reconcile', 'embedding-reconcile', 'embedding-reconcile', 'embedding-reconcile', 'title-summary', 'extract-curate', 'canopy-map', 'vault-seed'];
const DAY = 86_400_000;
const NOW = 1_790_000_000_000;

/** Project `i` of `n`, skewed: the first Project holds about as much as the rest together, as a busy repository does. */
const projectOf = (i: number, n: number): string => `proj_${Math.min(n - 1, Math.floor(n * (i % 97) ** 2 / 97 ** 2))}`;

/** A migrated store holding rows shaped like a Deployment's, analyzed, less the statistics the profile omits. */
export function analyzedStore(profile: StatsProfile): Database {
  const db = new Database(':memory:');
  for (const statement of SCHEMA_DDL) db.run(statement);
  db.run('PRAGMA foreign_keys = OFF');
  db.transaction(() => {
    for (let p = 0; p < profile.projects; p += 1) db.run(`INSERT INTO projects (project_id, name, created_at, archived_at) VALUES (?, ?, 0, ?)`, [`proj_${p}`, `p${p}`, p === profile.projects - 1 && p > 0 ? NOW : null]);
    for (let m = 0; m < 8; m += 1) {
      db.run(`INSERT INTO members (id, label, created_at) VALUES (?, ?, 0)`, [`mem_${m}`, `member ${m}`]);
      db.run(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, runtime_label, issued_at, expires_at, revoked_at, lineage_root, lineage_started_at)
              VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, 0)`, [`mt_${m}`, `mem_${m % 3}`, `h${m}`, `machine_${m % 4}`, `host${m % 4}`, NOW + DAY, m % 2 === 0 ? null : 1, `mt_${m}`]);
    }
    for (let i = 0; i < profile.sessions; i += 1) {
      const at = NOW - (profile.sessions - i) * 600_000;
      db.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, agent, branch, started_at, ended_at, title)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectOf(i, profile.projects), `s${i}`, `machine_${i % 4}`, `mt_${i % 8}`, at, at + 3_600_000, AGENTS[i % AGENTS.length], i % 5 === 0 ? 'main' : `feat/${i % 40}`, at, i % 20 === 0 ? null : at + 3_600_000, i % 3 === 0 ? null : `title ${i}`]);
    }
    for (let i = 0; i < profile.transcripts; i += 1) {
      db.run(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, size, first_received_at, last_received_at, token_id, parsed_offset, parser_version, imported_at)
              VALUES (?, ?, ?, 'machine_0', 1000, 0, 0, 't', ?, 3, ?)`, [projectOf(i, profile.projects), `tx${i}`, `s${i % profile.sessions}`, i % 50 === 0 ? 10 : 1000, i % 4 === 0 ? 1 : null]);
    }
    for (let i = 0; i < profile.runs; i += 1) {
      const task = TASKS[i % TASKS.length]!;
      const at = NOW - (profile.runs - i) * 60_000;
      const status = i % 15 === 0 ? 'failed' : i % 11 === 0 ? 'skipped' : 'completed';
      db.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, queued_at, tokens_used, cost_usd)
              VALUES (?, ?, 'agent', ?, ?, ?, ?, ?, ?, ?)`, [projectOf(i, profile.projects), `run_${i}`, task, status, at, at + 30_000, task === 'embedding-reconcile' ? null : at - 1000, 1000, 0.01]);
      if (task !== 'embedding-reconcile') {
        db.run(`INSERT INTO agent_run_events (project_id, run_id, event_type, tool_name, outcome, payload, recorded_at) VALUES (?, ?, 'run_write', 'myco_run_sessions', 'written', '{}', ?)`, [projectOf(i, profile.projects), `run_${i}`, at]);
        db.run(`INSERT INTO agent_reports (project_id, run_id, agent_id, action, summary, created_at) VALUES (?, ?, 'agent', 'extract', 'x', ?)`, [projectOf(i, profile.projects), `run_${i}`, at]);
        // A titling run reads its one session; an extraction run reads the handful a page of prompts spans.
        for (let k = 0; k < (task === 'extract-curate' ? 6 : 1); k += 1) {
          db.run(`INSERT OR IGNORE INTO run_reads (project_id, run_id, session_id, token_id, received_at) VALUES (?, ?, ?, 'mt_run', ?)`,
            [projectOf(i, profile.projects), `run_${i}`, `s${(i * 7 + k * 13) % profile.sessions}`, at]);
        }
      }
    }
    for (let i = 0; i < profile.spores; i += 1) {
      db.run(`INSERT INTO spores (project_id, id, agent_id, session_id, observation_type, status, content, author, created_at, embedded)
              VALUES (?, ?, 'agent', ?, ?, ?, 'x', ?, ?, 1)`,
      [projectOf(i, profile.projects), `sp${i}`, `s${i % profile.sessions}`, TYPES[i % TYPES.length], i % 6 === 0 ? 'superseded' : 'active',
        i % 5 === 0 ? `mem_${i % 3}` : `run_${(i * 7) % profile.runs}`, NOW - (profile.spores - i) * 900_000]);
    }
    for (let i = 0; i < profile.plans; i += 1) {
      db.run(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, created_at, updated_at, token_id, received_at)
              VALUES (?, ?, ?, ?, 'machine_0', 'h', ?, 0, ?, 't', 0)`,
      [projectOf(i, profile.projects), `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, `s${i % profile.sessions}`, `ev${i}`, ['active', 'completed', 'abandoned', 'in_progress'][i % 4], NOW - (profile.plans - i) * 3_600_000]);
    }
  })();
  db.run('ANALYZE');
  for (const index of profile.unanalyzed) db.run(`DELETE FROM sqlite_stat1 WHERE idx = ?`, [index]);
  // The statistics are read when the schema loads; this loads them again, as a connection opened later would.
  db.run('ANALYZE sqlite_schema');
  return db;
}
