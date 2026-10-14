import { repositoriesNeeded } from './repository-requirements.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { deploymentOwnerSql, linkedHumanAdminSql } from '../core/ownership.js';
import type { RelationalStore, ServerEnv } from '../core/adapters.js';
import { credentialLive } from '../db/liveness.js';
import { fleetReports, readWorkerFleet } from '../core/worker-contacts.js';
import type { MachineScope } from './machines.js';
import { MAX_WORK_WINDOW_MS } from './work.js';
import { projectsFiltering } from './scope.js';
import { producedSql } from './run-outcome.js';

const SETUP_CAPTURE_CANDIDATES_PER_HARNESS = 8;
const SETUP_CAPTURE_HARNESS_IDS = JSON.stringify(CAPTURE_RULE_BUNDLES.map(bundle => bundle.name));

export interface SetupObservations {
  repositoriesNeeded?: Array<{ projectId: string }>;
  machines: { signedIn: number };
  /** Admins count live projects; a member's own first project is evidenced by live capture (zero or one). */
  projects: number;
  liveCapture: boolean;
  runnersReady: number | null;
  workProduced: boolean;
  legacyWorkers: number | null;
  queuedWithoutRunner: boolean;
}

/** Current claims and authority gate capture; retained history alone establishes no machine's progress. */
export async function readSetupProgress(env: ServerEnv, scope: MachineScope, now: number): Promise<SetupObservations> {
  const liveClaim = `EXISTS (SELECT 1 FROM member_credentials c INDEXED BY idx_member_credentials_machine
    WHERE c.machine_id = mc.machine_id AND c.member_id = mc.member_id AND ${credentialLive('c')})`;
  const claims = `machine_claims mc INDEXED BY ${scope.all ? 'idx_machine_claims_claimed' : 'idx_machine_claims_member'}`;
  const claimScope = scope.all ? 'mc.claimed_at >= 0' : 'mc.member_id = ?';
  // Sessions whose agent isn't a known harness don't count.
  const capture = `EXISTS (SELECT 1 FROM ${claims} WHERE ${claimScope} AND ${liveClaim}
    AND EXISTS (SELECT 1 FROM json_each(?) h WHERE EXISTS (SELECT 1 FROM (
        SELECT s.project_id, s.session_id, s.created_by_token_id FROM sessions s INDEXED BY idx_sessions_harness_live
        WHERE s.machine_id = mc.machine_id AND s.agent = h.value
          AND s.last_live_received_at IS NOT NULL AND s.last_live_received_at >= mc.claimed_at
        ORDER BY s.last_live_received_at DESC LIMIT ${SETUP_CAPTURE_CANDIDATES_PER_HARNESS}
      ) s WHERE EXISTS (SELECT 1 FROM member_credentials source WHERE source.id = s.created_by_token_id
          AND source.member_id = mc.member_id AND source.machine_id = mc.machine_id)
        AND ${projectsFiltering({ all: true }, 's').sql}
        AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = s.project_id AND t.session_id = s.session_id))))`;
  const row = await env.db.prepare(`SELECT
    (SELECT COUNT(*) FROM ${claims} WHERE ${claimScope} AND ${liveClaim}) AS signed_in,
    ${scope.all ? `(SELECT COUNT(*) FROM projects p INDEXED BY sqlite_autoindex_projects_1 WHERE p.project_id > '' AND p.archived_at IS NULL)` : '0'} AS projects,
    ${capture} AS live_capture,
    EXISTS (SELECT 1 FROM agent_runs a INDEXED BY idx_fleet_queue WHERE a.status = 'queued'
      AND ${projectsFiltering({ all: true }, 'a').sql}) AS queued,
    EXISTS (SELECT 1 FROM runners WHERE id > '' AND state = 'enabled') AS enabled_runner`)
    .bind(...(scope.all ? [] : [scope.memberId]), now, ...(scope.all ? [] : [scope.memberId]), now, SETUP_CAPTURE_HARNESS_IDS)
    .first<{ signed_in: number; projects: number; live_capture: number; queued: number; enabled_runner: number }>();
  if (row === null) throw new Error('Setup observations unavailable');
  // Members receive only the queue boolean, with no runner inventory or outcome history.
  const fleet = scope.all ? await readWorkerFleet(env.db, now) : [];
  const runnersReady = scope.all ? fleetReports(fleet, true).filter(report => report.runner).length : null;
  const produced = scope.all ? await env.db.prepare(`SELECT EXISTS (SELECT 1 FROM agent_runs a INDEXED BY idx_agent_runs_retention
    WHERE a.resumable = 0 AND a.status IN ('completed', 'failed', 'skipped')
      AND COALESCE(a.completed_at, a.started_at) >= ? AND COALESCE(a.completed_at, a.started_at) <= ?
      AND a.status IN ('completed', 'failed')
      AND ${projectsFiltering({ all: true }, 'a').sql}
      AND ${producedSql('a')}) AS produced`).bind(now - MAX_WORK_WINDOW_MS, now).first<{ produced: number }>() : null;
  if (scope.all && produced === null) throw new Error('Setup work observation unavailable');
  return {
    repositoriesNeeded: scope.all ? await repositoriesNeeded(env.db, { all: true }) : [],
    machines: { signedIn: row.signed_in }, projects: scope.all ? row.projects : Number(row.live_capture === 1), liveCapture: row.live_capture === 1,
    runnersReady, workProduced: produced?.produced === 1,
    legacyWorkers: scope.all ? fleet.filter(worker => worker.runner === null && worker.eligible && worker.recent).length : null,
    queuedWithoutRunner: row.queued === 1 && row.enabled_runner === 0,
  };
}

export interface SetupIdentity { ownerLinked: boolean; viewerIsOwner: boolean }

/** Non-secret identity facts use the canonical human-admin and owner predicates. */
export async function readSetupIdentity(db: RelationalStore, viewerId: string): Promise<SetupIdentity> {
  const row = await db.prepare(`SELECT
    EXISTS (SELECT 1 FROM members m INDEXED BY idx_members_github_id
      WHERE m.github_id > '' AND ${linkedHumanAdminSql('m')}) AS owner_linked,
    ${deploymentOwnerSql('?')} AS viewer_is_owner`).bind(viewerId)
    .first<{ owner_linked: number; viewer_is_owner: number }>();
  if (row === null) throw new Error('Setup identity observation unavailable');
  return { ownerLinked: row.owner_linked === 1, viewerIsOwner: row.viewer_is_owner === 1 };
}
