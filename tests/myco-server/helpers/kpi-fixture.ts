import type { Database } from 'bun:sqlite';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { declaredScheme } from '@myco-server-worker/ingest/prompt-scheme.js';
import { seededSqlite } from './d1.js';

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const PROJECT = 'proj_one';
const OTHER = 'proj_two';

interface Rig {
  db: RelationalStore;
  sqlite: Database;
  session: (id: string, opts?: { project?: string; tokenId?: string; agent?: string | null; at?: number }) => void;
  prompt: (id: string, sessionId: string, opts?: { project?: string; at?: number }) => void;
  call: (id: string, sessionId: string, opts?: { project?: string; at?: number; tool?: string | null; op?: string | null }) => void;
  /** A receipt selected with `promptId`'s text and delivered to `deliveredTo` (that same prompt unless named; null for none). */
  sporeInjection: (sessionId: string, promptId: string, sporeIds: string[], opts?: { project?: string; at?: number; deliveredTo?: string | null; deliveredAt?: number }) => void;
  sessionInjection: (sessionId: string, kind: string, opts?: { project?: string; at?: number }) => void;
  credential: (id: string, opts?: { lineage?: string; startedAt?: number }) => void;
}

function rig(): Rig {
  const sqlite = seededSqlite();
  for (const p of [PROJECT, OTHER]) {
    sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(p, p, NOW);
  }
  sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES ('mem_1', 'chris', ?, NULL)`).run(NOW);

  // Prompts and Myco calls are measured from each session's live document catalog.
  let ord = 0;
  const live = (project: string, sessionId: string) => sqlite.query(`INSERT INTO session_documents (project_id, session_id, state, generation, updated_at)
    VALUES (?, ?, 'live', 1, ?) ON CONFLICT (project_id, session_id) DO UPDATE SET state = 'live', generation = 1`).run(project, sessionId, NOW);
  const r: Rig = {
    db: sqliteRelationalStore(sqlite),
    sqlite,
    credential: (id, opts = {}) => {
      sqlite.query(`INSERT INTO member_credentials (id, member_id, token_hash, machine_id, issued_at, expires_at, lineage_root, lineage_started_at, bytes_written)
                    VALUES (?, 'mem_1', ?, ?, ?, ?, ?, ?, 0)`)
        .run(id, `hash_${id}`, `machine_${id}`, NOW, NOW + DAY, opts.lineage ?? id, opts.startedAt ?? NOW);
    },
    session: (id, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
                    VALUES (?, ?, 'm1', ?, ?, ?)`)
        .run(opts.project ?? PROJECT, id, opts.tokenId ?? 'cred_1', at, at);
      live(opts.project ?? PROJECT, id);
      if (opts.agent !== null) {
        sqlite.query(`INSERT INTO transcripts (project_id, transcript_id, session_id, machine_id, agent, size, segment_count, first_received_at, last_received_at, token_id, role, prompt_identity_scheme)
                      VALUES (?, ?, ?, 'm1', ?, 0, 0, ?, ?, ?, 'primary', ?)`)
          .run(opts.project ?? PROJECT, `tr_${id}`, id, opts.agent ?? 'claude-code', at, at, opts.tokenId ?? 'cred_1', declaredScheme(opts.agent ?? 'claude-code'));
      }
    },
    prompt: (id, sessionId, opts = {}) => {
      const at = opts.at ?? NOW;
      sqlite.query(`INSERT INTO session_prompts (project_id, session_id, generation, prompt_id, turn_key, ord, origin, created_at)
                    VALUES (?, ?, 1, ?, ?, ?, 'user', ?)`)
        .run(opts.project ?? PROJECT, sessionId, id, id, ord++, at);
    },
    call: (id, sessionId, opts = {}) => {
      const at = opts.at ?? NOW;
      // The catalog keeps Myco's own calls; a call to any other tool leaves no row.
      const tool = opts.tool === undefined ? 'myco_search' : opts.tool;
      if (tool === null) return;
      sqlite.query(`INSERT INTO myco_tool_calls (project_id, session_id, generation, tool_call_id, myco_tool, myco_op, success, created_at)
                    VALUES (?, ?, 1, ?, ?, ?, 1, ?)`)
        .run(opts.project ?? PROJECT, sessionId, id, tool, opts.op ?? null, at);
    },
    sporeInjection: (sessionId, promptId, sporeIds, opts = {}) => {
      const at = opts.at ?? NOW;
      const deliveredTo = opts.deliveredTo === undefined ? promptId : opts.deliveredTo;
      sqlite.query(`INSERT INTO spore_injections (project_id, session_id, prompt_id, ask_protocol, asked_at, prompt_hash, spore_ids, plan_ids, created_at, delivered_at, delivered_prompt_id, delivered_scope_reason)
                    VALUES (?, ?, ?, 'v1', ?, ?, ?, '[]', ?, ?, ?, ?)`)
        .run(opts.project ?? PROJECT, sessionId, promptId, at, `ph_${promptId}`, JSON.stringify(sporeIds), at, opts.deliveredAt ?? (deliveredTo === null ? null : at), deliveredTo, deliveredTo === null && opts.deliveredAt !== undefined ? 'absent_key' : null);
    },
    sessionInjection: (sessionId, kind, opts = {}) => {
      sqlite.query(`INSERT INTO session_injections (project_id, session_id, kind, created_at) VALUES (?, ?, ?, ?)`)
        .run(opts.project ?? PROJECT, sessionId, kind, opts.at ?? NOW);
    },
  };
  return r;
}

export { rig, NOW, DAY, PROJECT, OTHER };
