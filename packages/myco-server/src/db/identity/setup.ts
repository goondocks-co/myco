import { RUN_ID_PREFIX } from '../../constants.js';
import { SETUP_OUTPUT_EVENT_INDEX, SETUP_OUTPUT_EVENT_WHERE } from '../schema-v712.js';
import { producedSql } from '../../read/run-outcome.js';
import { read, readSet } from '../index.js';
import { repositoriesNeeded } from '../../read/repository-requirements.js';
import { CAPTURE_RULE_BUNDLES } from '@goondocks/myco-shared/capture-rules-data';
import { deploymentOwnerSql, linkedHumanAdminSql } from './ownership-policy.js';
import type { RelationalStore, ServerEnv } from '../../core/adapters.js';
import { credentialLive } from '../liveness.js';
import { applyFleetSignInAvailability } from '../runs/fleet.js';
import { readWorkerFleet } from '../../core/worker-contacts.js';
import { harnessCredentialAvailability } from '../../core/secrets.js';
import type { MachineScope } from '../../read/machines.js';
import { visibleProjectSql } from '../storage/visible-projects.js';

const SETUP_CAPTURE_CANDIDATES_PER_HARNESS = 8;
const RUN_ID_PREFIX_END = RUN_ID_PREFIX.slice(0, -1) + String.fromCharCode(RUN_ID_PREFIX.charCodeAt(RUN_ID_PREFIX.length - 1) + 1);
const SETUP_CAPTURE_HARNESS_IDS = JSON.stringify(CAPTURE_RULE_BUNDLES.map(bundle => bundle.name));

export interface SetupObservations {
  repositoriesOverflow?: boolean;
  repositoriesNeeded?: Array<{ projectId: string; codeMap?: boolean }>;
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
  const statements = scope.all ? adminSetup.bind(now, now, SETUP_CAPTURE_HARNESS_IDS)
    : memberSetup.bind(scope.memberId, now, scope.memberId, now, SETUP_CAPTURE_HARNESS_IDS);
  const [observations, outputs] = await readSet(env.db, statements, ...(scope.all ? [producedRead.bind(now, RUN_ID_PREFIX, RUN_ID_PREFIX_END)] : []));
  const row = observations[0];
  if (row === undefined) throw new Error('Setup observations unavailable');
  // Members receive only the queue boolean, with no runner inventory or outcome history.
  const fleet = scope.all ? (await readWorkerFleet(env.db, now, true)).filter(row => row.recent && row.eligible) : [];
  if (scope.all) await applyFleetSignInAvailability(fleet, now, harnessCredentialAvailability(env.db, env.wrappingKey));
  const runnersReady = scope.all ? fleet.filter(row => row.runner !== null && row.runnerDetails?.readiness.state === 'ready').length : null;
  const produced = outputs?.[0] as { produced: number } | undefined;
  if (scope.all && produced === undefined) throw new Error('Setup work observation unavailable');
  const repositoryRequirements = scope.all ? await repositoriesNeeded(env, { all: true }) : { projects: [], overflow: false };
  return {
    repositoriesNeeded: repositoryRequirements.projects,
    ...(repositoryRequirements.overflow ? { repositoriesOverflow: true } : {}),
    machines: { signedIn: row.signed_in }, projects: scope.all ? row.projects : Number(row.live_capture === 1), liveCapture: row.live_capture === 1,
    runnersReady, workProduced: produced?.produced === 1,
    legacyWorkers: scope.all ? fleet.filter(worker => worker.runner === null).length : null,
    queuedWithoutRunner: row.queued === 1 && row.enabled_runner === 0,
  };
}

export interface SetupIdentity { ownerLinked: boolean; viewerIsOwner: boolean }

/** Non-secret identity facts use the canonical human-admin and owner predicates. */
export async function readSetupIdentity(db: RelationalStore, viewerId: string): Promise<SetupIdentity> {
  const [[row]] = await readSet(db, setupIdentityRead.bind(viewerId));
  if (row === undefined) throw new Error('Setup identity observation unavailable');
  return { ownerLinked: row.owner_linked === 1, viewerIsOwner: row.viewer_is_owner === 1 };
}

type SetupRow = { signed_in: number; projects: number; live_capture: number; queued: number; enabled_runner: number };
function setupStatement(all: boolean) {
  const liveClaim = `EXISTS (SELECT 1 FROM member_credentials c INDEXED BY idx_member_credentials_machine
    WHERE c.machine_id = mc.machine_id AND c.member_id = mc.member_id AND ${credentialLive('c')})`;
  const claims = `machine_claims mc INDEXED BY ${all ? 'idx_machine_claims_claimed' : 'idx_machine_claims_member'}`;
  const claimScope = all ? 'mc.claimed_at >= 0' : 'mc.member_id = ?';
  // Sessions whose agent isn't a known harness don't count.
  const capture = `EXISTS (SELECT 1 FROM ${claims} WHERE ${claimScope} AND ${liveClaim}
    AND EXISTS (SELECT 1 FROM json_each(?) h WHERE EXISTS (SELECT 1 FROM (
        SELECT s.project_id, s.session_id, s.created_by_token_id FROM sessions s INDEXED BY idx_sessions_harness_live
        WHERE s.machine_id = mc.machine_id AND s.agent = h.value
          AND s.last_live_received_at IS NOT NULL AND s.last_live_received_at >= mc.claimed_at
        ORDER BY s.last_live_received_at DESC LIMIT ${SETUP_CAPTURE_CANDIDATES_PER_HARNESS}
      ) s WHERE EXISTS (SELECT 1 FROM member_credentials source WHERE source.id = s.created_by_token_id
          AND source.member_id = mc.member_id AND source.machine_id = mc.machine_id)
        AND ${visibleProjectSql('s')}
        AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = s.project_id AND t.session_id = s.session_id))))`;

  return read<Array<string | number>, SetupRow>({ name: all ? 'identity.setupAdmin' : 'identity.setupMember', sql: `SELECT
    (SELECT COUNT(*) FROM ${claims} WHERE ${claimScope} AND ${liveClaim}) AS signed_in,
    ${all ? `(SELECT COUNT(*) FROM projects p INDEXED BY sqlite_autoindex_projects_1 WHERE p.project_id > '' AND p.archived_at IS NULL)` : '0'} AS projects,
    ${capture} AS live_capture,
    EXISTS (SELECT 1 FROM agent_runs a INDEXED BY idx_fleet_queue WHERE a.status = 'queued'
      AND ${visibleProjectSql('a')}) AS queued,
    EXISTS (SELECT 1 FROM runners WHERE id > '' AND state = 'enabled') AS enabled_runner` });
}
const adminSetup = setupStatement(true);
const memberSetup = setupStatement(false);
const outputRun = (source: string, key: string, predicate: string) => `EXISTS (
  SELECT 1 FROM ${source} CROSS JOIN agent_runs a ON a.project_id=p.project_id AND a.id=${key}
  WHERE ${predicate} AND a.status IN ('completed','failed')
    AND COALESCE(a.completed_at,a.started_at)<=?1 AND ${producedSql('a')})`;
const producedRead = read<[number, string, string], { produced: number }>({ name: 'identity.setupProduced', sql: `SELECT EXISTS(
  SELECT 1 FROM projects p WHERE p.archived_at IS NULL AND (
    ${outputRun('spores sp INDEXED BY idx_spores_author', 'sp.author', 'sp.project_id=p.project_id AND sp.author >= ?2 AND sp.author < ?3')}
    OR ${outputRun(`agent_run_events e INDEXED BY ${SETUP_OUTPUT_EVENT_INDEX}`, 'e.run_id',
      `e.project_id=p.project_id AND ${SETUP_OUTPUT_EVENT_WHERE}`)})) AS produced` });

const setupIdentityRead = read<[string], { owner_linked: number; viewer_is_owner: number }>({ name: 'identity.setupIdentity', sql: `SELECT
    EXISTS (SELECT 1 FROM members m INDEXED BY idx_members_github_id
      WHERE m.github_id > '' AND ${linkedHumanAdminSql('m')}) AS owner_linked,
    ${deploymentOwnerSql('?')} AS viewer_is_owner` });
