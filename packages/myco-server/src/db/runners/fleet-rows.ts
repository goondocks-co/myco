import type { RelationalStore } from '../../core/adapters.js';
import { read, readSet } from '../index.js';
import { runParentLive } from '../runs/run-parent.js';
import { RUNNER_HEADS_READY_SQL, MACHINE_HEADS_READY_SQL, runnerAttemptHistory, runnerTerminalHistory } from './heads.js';

export interface MemberFleetRow {
  credential_id: string;
  credential_machine_id: string | null;
  revoked_at: number | null;
  expires_at: number | null;
  member_role: string | null;
  member_revoked_at: number | null;
  contact_machine_id: string | null;
  offers: string | null;
  capabilities: string | null;
  last_reason: string | null;
  last_seen_at: number | null;
  run_id: string | null;
  project_id: string | null;
  task: string | null;
  lease_expires_at: number | null;
}

/**
 * The legacy workers worth listing: each machine's latest contact, anyone heard from recently, and anyone holding a live
 * lease, so a machine's rotated credentials never add rows. While the heads build, every contact is listed instead.
 */
const memberRead = read<[now: number, recentSince: number], MemberFleetRow>({ name: 'runners.memberFleet', sql: `WITH inventory AS (
    SELECT h.latest_contact_credential_id AS credential_id FROM machine_head h
      WHERE EXISTS (SELECT 1 FROM worker_contacts w WHERE w.credential_id = h.latest_contact_credential_id)
    UNION SELECT credential_id FROM worker_contacts INDEXED BY idx_worker_contacts_seen WHERE last_seen_at >= ?2
    UNION SELECT w.credential_id FROM (SELECT 1 WHERE NOT (${MACHINE_HEADS_READY_SQL})) building CROSS JOIN worker_contacts w
    UNION SELECT leased_by AS credential_id FROM agent_runs INDEXED BY idx_fleet_legacy_leases
      WHERE status = 'running' AND lease_expires_at > ?1 AND leased_by IS NOT NULL
  )
  SELECT c.id AS credential_id, c.machine_id AS credential_machine_id, c.revoked_at, c.expires_at,
         m.role AS member_role, m.revoked_at AS member_revoked_at,
         w.machine_id AS contact_machine_id, w.offers, w.capabilities, w.last_reason, w.last_seen_at,
         r.id AS run_id, r.project_id, r.task, r.lease_expires_at
    FROM inventory i
    CROSS JOIN member_credentials c ON c.id = i.credential_id
    LEFT JOIN members m ON m.id = c.member_id
    LEFT JOIN worker_contacts w ON w.credential_id = c.id
    LEFT JOIN agent_runs r INDEXED BY idx_agent_runs_lease ON r.leased_by = c.id AND r.status = 'running' AND r.lease_expires_at > ?1` });

export interface RunnerFleetRow {
  id: string;
  name: string;
  state: string;
  revision: number;
  created_at: number;
  created_by_member: string | null;
  removed_at: number | null;
  labels: string;
  last_contact_at: number | null;
  replacement_pending: number;
  credential_choices: string;
  machine_id: string | null;
  os: string | null;
  version: string | null;
  offers: string | null;
  capabilities: string | null;
  last_reason: string | null;
  last_seen_at: number | null;
  updated_at: number | null;
  arch: string | null;
  availability: string | null;
  readiness_reason: string | null;
  observed_at: number | null;
  run_id: string | null;
  project_id: string | null;
  project_name: string | null;
  task: string | null;
  started_at: number | null;
  lease_expires_at: number | null;
  channel: string | null;
  latest_version: string | null;
  last_check_at: number | null;
  last_result: string | null;
  update_request_id: string | null;
  requested_at: number | null;
  last_attempted: string | null;
  last_completed: string | null;
  last_failed: string | null;
  models: string;
  credentialed: number;
}

/** A head value, naming its Project; before the heads are complete, an unseeded runner's value comes from its history. */
const headValue = (column: string, history: string): string => `CASE WHEN h.seeded = 1 OR ${RUNNER_HEADS_READY_SQL}
    THEN json_set(h.${column}, '$.projectName', (SELECT name FROM projects WHERE project_id = json_extract(h.${column}, '$.projectId')))
    ELSE json_set(${history}, '$.projectName', (SELECT name FROM projects WHERE project_id = json_extract(${history}, '$.projectId'))) END AS ${column}`;

const runnerColumns = `r.id, r.name, r.state, r.revision, r.created_at, r.created_by_member, r.removed_at, r.labels,
    r.last_contact_at, r.replacement_pending, r.credential_choices,
    w.machine_id, w.os, COALESCE(u.current_version, w.version) AS version,
    w.offers, w.capabilities, w.last_reason, w.last_seen_at, w.updated_at,
    o.arch, o.availability, o.reason AS readiness_reason, o.observed_at,
    a.id AS run_id, a.project_id, (SELECT name FROM projects WHERE project_id = a.project_id) AS project_name,
    a.task, a.started_at, a.lease_expires_at,
    u.channel, u.latest_version, u.last_check_at, u.last_result,
    q.id AS update_request_id, q.requested_at,
    ${headValue('last_attempted', runnerAttemptHistory('r.id'))},
    ${headValue('last_completed', runnerTerminalHistory('completed', 'r.id'))},
    ${headValue('last_failed', runnerTerminalHistory('failed', 'r.id'))},
    (SELECT json_group_array(json_object('harness', mc.harness, 'source', mc.source, 'available', mc.available,
      'fetchedAt', mc.fetched_at, 'receivedAt', mc.received_at)) FROM runner_model_catalogs mc WHERE mc.runner_id = r.id) AS models,
    EXISTS (SELECT 1 FROM runner_credentials c WHERE c.runner_id = r.id AND c.epoch = r.credential_epoch
      AND c.revoked_at IS NULL AND c.expires_at > ?1) AS credentialed`;
const runnerJoins = `LEFT JOIN runner_contacts w ON w.runner_id = r.id
    LEFT JOIN runner_observations o ON o.runner_id = r.id
    LEFT JOIN runner_update_reports u ON u.runner_id = r.id
    LEFT JOIN runner_update_requests q ON q.runner_id = r.id
    LEFT JOIN runner_head h ON h.runner_id = r.id
    LEFT JOIN agent_runs a INDEXED BY idx_agent_runs_runner_lease ON a.leased_runner_id = r.id AND a.status = 'running' AND a.lease_expires_at > ?1
      AND ${runParentLive('a')}`;

const activeRead = read<[now: number], RunnerFleetRow>({ name: 'runners.activeFleet', sql: `SELECT ${runnerColumns}
    FROM runners r INDEXED BY idx_runners_active_name ${runnerJoins} WHERE r.state <> 'removed' ORDER BY r.name, r.id` });

const removedRead = read<[now: number, limit: number], RunnerFleetRow>({ name: 'runners.removedFleet', sql: `SELECT ${runnerColumns}
    FROM runners r ${runnerJoins} WHERE r.state = 'removed' ORDER BY r.removed_at DESC, r.id LIMIT ?2` });
const removedAfter = read<[now: number, limit: number, removedAt: number, id: string], RunnerFleetRow>({ name: 'runners.removedFleetAfter', sql: `SELECT ${runnerColumns}
    FROM runners r ${runnerJoins} WHERE r.state = 'removed' AND (r.removed_at < ?3 OR (r.removed_at = ?3 AND r.id > ?4)) ORDER BY r.removed_at DESC, r.id LIMIT ?2` });

/** The fleet's legacy contacts and active runners, in one snapshot. */
export const fleetRows = (db: RelationalStore, now: number, recentSince: number) => readSet(db, memberRead.bind(now, recentSince), activeRead.bind(now));
export const removedRunnerRows = async (db: RelationalStore, now: number, limit: number, after: { removedAt: number; id: string } | null) =>
  (await readSet(db, after === null ? removedRead.bind(now, limit) : removedAfter.bind(now, limit, after.removedAt, after.id)))[0];
