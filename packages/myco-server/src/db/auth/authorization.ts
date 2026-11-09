import type { RelationalStore } from '../../core/adapters.js';
import type { HeldRun } from '../runs/lifecycle.js';
import { runParentLive } from '../runs/run-parent.js';
import { linkedAdmin } from '../identity/link-policy.js';
import { RUN_COLUMNS } from '../runs/run-columns.js';
import { commitNamed, read, type Bound } from '../index.js';

export interface MemberAuthorityRow { id: string; role: string; revoked_at: number | null; owner: string | null }
export interface CredentialAuthorityRow { member_id: string; owner: string | null }
export interface MachineClaimRow { machine_id: string; member_id: string; owner: string | null }
export interface RunAuthorityRow { id: string; dispatch_spec: string | null }

const deployment = read<[], { value: string }>({ name: 'authz.deployment', sql: "SELECT value FROM schema_meta WHERE key='deployment_id'" });
const ownership = read<[], { member_id: string | null }>({ name: 'authz.ownership', sql: 'SELECT member_id FROM deployment_ownership WHERE id=1' });
const member = read<[member: string], MemberAuthorityRow>({
  name: 'authz.member',
  sql: 'SELECT m.id,m.role,m.revoked_at,o.member_id AS owner FROM members m LEFT JOIN deployment_ownership o ON o.id=1 WHERE m.id=?1',
});
const liveCredential = read<[token: string, member: string, now: number], { id: string }>({
  name: 'authz.liveCredential',
  sql: `SELECT c.id FROM member_credentials c JOIN members m ON m.id=c.member_id
    WHERE c.id=?1 AND c.member_id=?2 AND c.revoked_at IS NULL AND c.expires_at>?3 AND m.revoked_at IS NULL`,
});
const liveGrant = read<[grant: string, now: number], { project_id: string }>({
  name: 'authz.liveGrant', sql: 'SELECT project_id FROM external_grants WHERE id=?1 AND revoked_at IS NULL AND expires_at>?2',
});
const heldRuns = read<[token: string], HeldRun>({
  name: 'authz.heldRuns',
  sql: `SELECT project_id AS projectId,${RUN_COLUMNS} FROM agent_runs WHERE dispatched_by = ?1 AND status = 'running' AND ${runParentLive()}`,
});
const project = read<[project: string], { present: number }>({ name: 'authz.project', sql: 'SELECT 1 AS present FROM projects WHERE project_id=?1' });
const credential = read<[token: string], CredentialAuthorityRow>({
  name: 'authz.credential',
  sql: 'SELECT c.member_id,o.member_id AS owner FROM member_credentials c LEFT JOIN deployment_ownership o ON o.id=1 WHERE c.id=?1',
});
const uploader = read<[token: string], { member_id: string }>({ name: 'authz.uploader', sql: 'SELECT member_id FROM member_credentials WHERE id=?1' });
const machines = read<[ids: string], MachineClaimRow>({
  name: 'authz.machines',
  sql: 'SELECT mc.machine_id,mc.member_id,o.member_id AS owner FROM machine_claims mc LEFT JOIN deployment_ownership o ON o.id=1 WHERE mc.machine_id IN (SELECT value FROM json_each(?1))',
});
const runner = read<[runner: string], { id: string }>({ name: 'authz.runner', sql: 'SELECT id FROM runners WHERE id=?1' });
const run = read<[project: string, run: string], RunAuthorityRow>({ name: 'authz.run', sql: 'SELECT id,dispatch_spec FROM agent_runs WHERE project_id=?1 AND id=?2' });
const linkedAdminPresent = read<[], { present: number }>({ name: 'authz.linkedAdminPresent', sql: `SELECT 1 AS present FROM members la WHERE ${linkedAdmin('la')} LIMIT 1` });

/** What one request must know to be decided; each named part adds one bounded read to the set. */
export interface AuthorizationQuery {
  subjectMember?: string;
  targetMember?: string;
  ownership?: boolean;
  liveCredential?: { tokenId: string; memberId: string; now: number };
  grant?: { id: string; now: number };
  heldRuns?: string;
  project?: string;
  credential?: string;
  uploader?: string;
  machines?: readonly string[];
  runner?: string;
  run?: { projectId: string; runId: string };
  linkedAdminPresent?: boolean;
}

export interface AuthorizationSnapshot {
  deploymentId: string;
  subjectMember: MemberAuthorityRow | null;
  targetMember: MemberAuthorityRow | null;
  /** Null when the singleton is absent or not asked for; `memberId` is null while no owner is recorded. */
  ownership: { memberId: string | null } | null;
  credentialLive: boolean;
  grant: { projectId: string } | null;
  heldRuns: HeldRun[];
  projectExists: boolean;
  credential: CredentialAuthorityRow | null;
  uploaderMemberId: string | null;
  machineClaims: MachineClaimRow[];
  runnerId: string | null;
  run: RunAuthorityRow | null;
  linkedAdminPresent: boolean;
}

const when = <Row>(bound: Bound<Row, 'read'> | undefined): readonly Bound<Row, 'read'>[] => bound === undefined ? [] : [bound];

/**
 * One consistent read of everything a request is decided on. It decides the request and authorizes no write: each
 * write path asserts its authority in its own commit (the write-authority stores, `memberWriteStore`, `runWriteStore`,
 * `runnerWriteStore`, revision fences, or capture's `TOKEN_LIVE`), so a snapshot that has gone stale refuses there.
 */
export async function readAuthorization(db: RelationalStore, query: AuthorizationQuery): Promise<AuthorizationSnapshot> {
  const result = await commitNamed(db, {
    deployment: deployment.bind(),
    subjectMember: when(query.subjectMember === undefined ? undefined : member.bind(query.subjectMember)),
    targetMember: when(query.targetMember === undefined ? undefined : member.bind(query.targetMember)),
    ownership: when(query.ownership === true ? ownership.bind() : undefined),
    liveCredential: when(query.liveCredential === undefined ? undefined : liveCredential.bind(query.liveCredential.tokenId, query.liveCredential.memberId, query.liveCredential.now)),
    grant: when(query.grant === undefined ? undefined : liveGrant.bind(query.grant.id, query.grant.now)),
    heldRuns: when(query.heldRuns === undefined ? undefined : heldRuns.bind(query.heldRuns)),
    project: when(query.project === undefined ? undefined : project.bind(query.project)),
    credential: when(query.credential === undefined ? undefined : credential.bind(query.credential)),
    uploader: when(query.uploader === undefined ? undefined : uploader.bind(query.uploader)),
    machines: when(query.machines === undefined ? undefined : machines.bind(JSON.stringify(query.machines))),
    runner: when(query.runner === undefined ? undefined : runner.bind(query.runner)),
    run: when(query.run === undefined ? undefined : run.bind(query.run.projectId, query.run.runId)),
    linkedAdminPresent: when(query.linkedAdminPresent === true ? linkedAdminPresent.bind() : undefined),
  });
  const deploymentId = result.deployment.results[0]?.value;
  if (!deploymentId) throw new Error('Deployment identity is missing');
  const single = <Row>(rows: readonly { results: Row[] }[]): Row | null => rows[0]?.results[0] ?? null;
  const owner = single(result.ownership);
  return {
    deploymentId,
    subjectMember: single(result.subjectMember),
    targetMember: single(result.targetMember),
    ownership: owner === null ? null : { memberId: owner.member_id },
    credentialLive: single(result.liveCredential) !== null,
    grant: single(result.grant) === null ? null : { projectId: single(result.grant)!.project_id },
    heldRuns: result.heldRuns[0]?.results ?? [],
    projectExists: single(result.project) !== null,
    credential: single(result.credential),
    uploaderMemberId: single(result.uploader)?.member_id ?? null,
    machineClaims: result.machines[0]?.results ?? [],
    runnerId: single(result.runner)?.id ?? null,
    run: single(result.run),
    linkedAdminPresent: single(result.linkedAdminPresent) !== null,
  };
}
