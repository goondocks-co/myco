import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { EXTRACTION_TASK } from '@myco-server-worker/core/task-catalogue.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
export const MISLEADING_HISTORY = {
  projectId: 'proj_setup_history', memberId: 'mem_setup_history',
  machineId: 'machine_setup_other', sessionId: 'session_setup_imported',
  agentId: 'agent_setup_history', runId: 'run_setup_empty', runnerId: 'rn_setup_offline',
} as const;

/** Imported capture, empty completed work, an aged offer and another machine's claim. Works with either store adapter. */
export async function seedMisleadingHistory(db: RelationalStore, now: number): Promise<typeof MISLEADING_HISTORY> {
  const h = MISLEADING_HISTORY;
  const old = now - 40 * DAY_MS;
  await db.batch([
    db.prepare('INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)').bind(h.projectId, 'Imported project', old),
    db.prepare("INSERT INTO members (id, label, created_at, role) VALUES (?, ?, ?, 'member')").bind(h.memberId, 'Other machine member', old),
    db.prepare('INSERT INTO machine_claims (machine_id, member_id, claimed_at) VALUES (?, ?, ?)').bind(h.machineId, h.memberId, old),
    db.prepare('INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at, last_live_received_at, agent) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
      .bind(h.projectId, h.sessionId, h.machineId, 'fixture-import', now, now, 'claude-code'),
    db.prepare("INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, ?, 'built-in', 1, ?)").bind(h.agentId, 'Fixture agent', old),
    db.prepare("INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at) VALUES (?, ?, ?, ?, 'completed', ?, ?)")
      .bind(h.projectId, h.runId, h.agentId, EXTRACTION_TASK, old, old + 1),
    db.prepare('INSERT INTO runners (id, name, created_at, created_by_member) VALUES (?, ?, ?, ?)').bind(h.runnerId, 'Offline fixture runner', old, h.memberId),
    db.prepare('INSERT INTO runner_contacts (runner_id, machine_id, offers, last_seen_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .bind(h.runnerId, h.machineId, JSON.stringify([{ id: 'codex', authenticated: true }]), old, old),
  ]);
  return h;
}
