import type { RelationalStore } from '../../core/adapters.js';
import { assertion, commit, commitNamed, first, read, refusalCode, refused, write, type Bound } from '../index.js';

/** A live owner or administrator, by member id; a held or revoked member is neither. */
const liveRunnerAdmin = (member: string): string => `EXISTS (SELECT 1 FROM members approver WHERE approver.id = ${member} AND approver.revoked_at IS NULL
  AND (approver.role = 'admin' OR EXISTS (SELECT 1 FROM deployment_ownership o WHERE o.id = 1 AND o.member_id = approver.id)))`;
/** The approver check other runner writers carry. */
export const liveRunnerAdminPredicate = liveRunnerAdmin;

const REMOVAL_REVOKER = 'runner-removed';
export const registrationRefused = refusalCode('myco_runner_registration_refused');

const PENDING_REQUEST = `EXISTS (SELECT 1 FROM device_requests d WHERE d.id = ?1 AND d.subject = 'runner'
  AND d.decision IS NULL AND d.expires_at > ?2 AND NOT EXISTS (SELECT 1 FROM device_decision_audit a WHERE a.request_id = d.id))`;
const newRegistration = assertion<[request: string, now: number, approver: string]>({ name: 'runners.registerNew', refusal: registrationRefused,
  when: `${PENDING_REQUEST} AND ${liveRunnerAdmin('?3')} AND EXISTS (SELECT 1 FROM device_requests WHERE id = ?1 AND replacing_runner_id IS NULL)` });
const replacementRegistration = assertion<[request: string, now: number, approver: string, runner: string, revision: number]>({ name: 'runners.registerReplacement', refusal: registrationRefused,
  when: `${PENDING_REQUEST} AND ${liveRunnerAdmin('?3')} AND EXISTS (SELECT 1 FROM runners r JOIN device_requests d ON d.id = ?1 AND d.runner_name = r.name
    WHERE r.id = ?4 AND r.revision = ?5 AND r.state <> 'removed' AND d.replacing_runner_id = r.id)` });

const insertRunner = write<[runner: string, now: number, approver: string, request: string]>({ name: 'runners.insert', sql:
  `INSERT INTO runners (id, name, state, credential_epoch, revision, labels, created_at, created_by_member, registration_id)
    SELECT ?1, d.runner_name, 'enabled', 1, 1, '[]', ?2, ?3, d.id FROM device_requests d WHERE d.id = ?4 AND d.subject = 'runner'` });
const recredentialRunner = write<[epoch: number, request: string, runner: string]>({ name: 'runners.recredential', sql:
  `UPDATE runners SET credential_epoch = ?1, revision = revision + 1, registration_id = ?2, credential_choices = '{}' WHERE id = ?3` });
const revokeOldCredentials = write<[now: number, runner: string]>({ name: 'runners.recredentialRevoke', sql:
  `UPDATE runner_credentials SET revoked_at = ?1, revoked_by = 'runner-recredentialed' WHERE runner_id = ?2 AND revoked_at IS NULL` });
const insertFirstCredential = write<[credential: string, runner: string, epoch: number, now: number, expiresAt: number, request: string]>({ name: 'runners.insertFirstCredential', sql:
  `INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, predecessor_id, lineage_root)
    SELECT ?1, ?2, d.candidate_hash, ?3, ?4, ?5, NULL, ?1 FROM device_requests d WHERE d.id = ?6 AND d.subject = 'runner'` });
const auditRegistered = write<[id: string, runner: string, approver: string, now: number]>({ name: 'runners.auditRegistered', sql:
  `INSERT INTO runner_audit (id, runner_id, actor_member, action, revision, at) VALUES (?1, ?2, ?3, 'registered', 1, ?4)` });
const auditRecredentialed = write<[id: string, runner: string, approver: string, revision: number, now: number]>({ name: 'runners.auditRecredentialed', sql:
  `INSERT INTO runner_metadata_audit(id,runner_id,actor_member,action,revision,detail,at) VALUES (?1,?2,?3,'recredentialed',?4,'{}',?5)` });
const approveRequest = write<[approver: string, now: number, request: string]>({ name: 'runners.approveDeviceRequest', sql:
  `UPDATE device_requests SET decision = 'approved', decided_by = ?1, decided_at = ?2 WHERE id = ?3 AND subject = 'runner' AND decision IS NULL` });
const auditDecision = write<[source: string, request: string]>({ name: 'runners.auditDeviceDecision', sql:
  `INSERT INTO device_decision_audit (request_id, member_id, machine_id, machine_name, os, source_hash, decision, decided_at, subject)
    SELECT id, decided_by, machine_id, machine_name, os, ?1, decision, decided_at, subject FROM device_requests WHERE id = ?2 AND decision = 'approved'` });

const epochRead = read<[runner: string], { epoch: number }>({ name: 'runners.credentialEpoch', sql: 'SELECT credential_epoch AS epoch FROM runners WHERE id = ?1' });
const requestChoicesRead = read<[request: string], { runner_credential_choices: string }>({ name: 'runners.requestChoices', sql: 'SELECT runner_credential_choices FROM device_requests WHERE id = ?1' });
export const runnerEpoch = async (db: RelationalStore, runnerId: string): Promise<number> => (await first(db, epochRead.bind(runnerId)))!.epoch;
export const requestedCredentialChoices = async (db: RelationalStore, requestId: string): Promise<string | null> => (await first(db, requestChoicesRead.bind(requestId)))?.runner_credential_choices ?? null;

export interface Registration {
  approver: string;
  request: string;
  source: string;
  now: number;
  runner: string;
  credential: string;
  epoch: number;
  expiresAt: number;
  replacing: { revision: number; invalidations: readonly Bound[] } | null;
  signIns: readonly Bound[];
}

/** The runner, its first credential, its audit, the decision and its receipt commit together. Answers false when the request or approver no longer admits it. */
export async function commitRegistration(db: RelationalStore, r: Registration): Promise<boolean> {
  try {
    await commit(db,
      r.replacing === null ? newRegistration.bind(r.request, r.now, r.approver) : replacementRegistration.bind(r.request, r.now, r.approver, r.runner, r.replacing.revision),
      ...(r.replacing === null ? [insertRunner.bind(r.runner, r.now, r.approver, r.request)] : [
        recredentialRunner.bind(r.epoch, r.request, r.runner), revokeOldCredentials.bind(r.now, r.runner), ...r.replacing.invalidations,
      ]),
      insertFirstCredential.bind(r.credential, r.runner, r.epoch, r.now, r.expiresAt, r.request),
      r.replacing === null ? auditRegistered.bind(crypto.randomUUID(), r.runner, r.approver, r.now) : auditRecredentialed.bind(crypto.randomUUID(), r.runner, r.approver, r.replacing.revision + 1, r.now),
      ...r.signIns,
      approveRequest.bind(r.approver, r.now, r.request),
      auditDecision.bind(r.source, r.request),
    );
    return true;
  } catch (error) {
    if (refused(error, registrationRefused) || (error instanceof Error && /UNIQUE constraint failed/.test(error.message))) return false;
    throw error;
  }
}

export interface RunnerRecord {
  id: string;
  name: string;
  state: 'enabled' | 'paused' | 'removed';
  revision: number;
  createdAt: number;
  createdBy: string | null;
  removedAt: number | null;
}

const RUNNER_COLUMNS = 'id, name, state, revision, created_at AS createdAt, created_by_member AS createdBy, removed_at AS removedAt';
const runnerRead = read<[runner: string], RunnerRecord>({ name: 'runners.read', sql: `SELECT ${RUNNER_COLUMNS} FROM runners WHERE id = ?1` });
export const readRunnerRecord = (db: RelationalStore, runnerId: string): Promise<RunnerRecord | null> => first(db, runnerRead.bind(runnerId));
const acceptsWork = read<[runner: string], { one: number }>({ name: 'runners.acceptsWork', sql: `SELECT 1 AS one FROM runners WHERE id = ?1 AND state = 'enabled'` });
export const runnerAcceptsNewWork = async (db: RelationalStore, runnerId: string): Promise<boolean> => await first(db, acceptsWork.bind(runnerId)) !== null;
const ofRegistration = read<[request: string], { id: string; name: string }>({ name: 'runners.ofRegistration', sql: 'SELECT id, name FROM runners WHERE registration_id = ?1' });
export const registeredRunner = (db: RelationalStore, requestId: string): Promise<{ id: string; name: string } | null> => first(db, ofRegistration.bind(requestId));

export type ControlTransition = 'pause' | 'resume' | 'remove';
const CONTROL_FROM: Readonly<Record<ControlTransition, string>> = { pause: `state = 'enabled'`, resume: `state = 'paused'`, remove: `state <> 'removed'` };
const CONTROL_TO: Readonly<Record<ControlTransition, RunnerRecord['state']>> = { pause: 'paused', resume: 'enabled', remove: 'removed' };
const CONTROL_AUDIT: Readonly<Record<ControlTransition, string>> = { pause: 'paused', resume: 'resumed', remove: 'removed' };

const transition = (control: Exclude<ControlTransition, 'remove'>) => write<[runner: string, revision: number, actor: string], { id: string }>({ name: `runners.control${control[0]!.toUpperCase()}${control.slice(1)}`, sql:
  `UPDATE runners SET state = '${CONTROL_TO[control]}', revision = revision + 1 WHERE id = ?1 AND revision = ?2 AND ${CONTROL_FROM[control]} AND ${liveRunnerAdmin('?3')} RETURNING id` });
const pauseOrResume = { pause: transition('pause'), resume: transition('resume') };
const removeRunner = write<[now: number, runner: string, revision: number, actor: string], { id: string }>({ name: 'runners.controlRemove', sql:
  `UPDATE runners SET state = 'removed', revision = revision + 1, removed_at = ?1, credential_epoch = credential_epoch + 1 WHERE id = ?2 AND revision = ?3 AND ${CONTROL_FROM.remove} AND ${liveRunnerAdmin('?4')} RETURNING id` });
const removalRevoke = write<[now: number, runner: string, revision: number]>({ name: 'runners.controlRemoveRevoke', sql:
  `UPDATE runner_credentials SET revoked_at = ?1, revoked_by = '${REMOVAL_REVOKER}' WHERE runner_id = ?2 AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM runners WHERE id = ?2 AND state = 'removed' AND revision = ?3)` });
const auditControl = write<[id: string, actor: string, action: string, now: number, runner: string, revision: number, state: string]>({ name: 'runners.controlAudit', sql:
  `INSERT INTO runner_audit (id, runner_id, actor_member, action, revision, at)
    SELECT ?1, id, ?2, ?3, revision, ?4 FROM runners WHERE id = ?5 AND revision = ?6 AND state = ?7
      AND NOT EXISTS (SELECT 1 FROM runner_audit receipt WHERE receipt.runner_id = runners.id AND receipt.revision = runners.revision)` });

/** The transition, the removal's revocations and the audit commit together; a control the runner's state no longer admits writes nothing. Answers whether it moved. */
export async function commitRunnerControl(db: RelationalStore, control: ControlTransition, runner: { id: string; revision: number }, actor: string, now: number): Promise<boolean> {
  const { moved } = await commitNamed(db, {
    moved: control === 'remove' ? removeRunner.bind(now, runner.id, runner.revision, actor) : pauseOrResume[control].bind(runner.id, runner.revision, actor),
    revoked: control === 'remove' ? [removalRevoke.bind(now, runner.id, runner.revision + 1)] : [],
    audit: auditControl.bind(crypto.randomUUID(), actor, CONTROL_AUDIT[control], now, runner.id, runner.revision + 1, CONTROL_TO[control]),
  });
  return moved.results.length === 1;
}

const adminAtRevision = assertion<[actor: string, runner: string, revision: number]>({ name: 'runners.adminAtRevision', refusal: registrationRefused,
  when: `${liveRunnerAdmin('?1')} AND EXISTS (SELECT 1 FROM runners WHERE id = ?2 AND revision = ?3 AND state <> 'removed')` });
const renameTo = write<[name: string, runner: string]>({ name: 'runners.rename', sql: 'UPDATE runners SET name = ?1, revision = revision + 1 WHERE id = ?2' });
const auditRenamed = write<[id: string, runner: string, actor: string, revision: number, detail: string, now: number]>({ name: 'runners.auditRenamed', sql:
  `INSERT INTO runner_metadata_audit(id,runner_id,actor_member,action,revision,detail,at) VALUES (?1,?2,?3,'renamed',?4,?5,?6)` });

/** A rename with its live actor guard and immutable receipt. Answers false when the actor or the revision no longer holds. */
export async function commitRunnerRename(db: RelationalStore, rename: { actor: string; runner: string; revision: number; name: string; now: number; changed: boolean }): Promise<boolean> {
  try {
    await commit(db, adminAtRevision.bind(rename.actor, rename.runner, rename.revision), ...(rename.changed ? [
      renameTo.bind(rename.name, rename.runner),
      auditRenamed.bind(crypto.randomUUID(), rename.runner, rename.actor, rename.revision + 1, JSON.stringify({ name: rename.name }), rename.now),
    ] : []));
    return true;
  } catch (error) {
    if (refused(error, registrationRefused)) return false;
    throw error;
  }
}

const choicesRead = read<[runner: string], { credential_choices: string }>({ name: 'runners.credentialChoices', sql: 'SELECT credential_choices FROM runners WHERE id = ?1' });
export const storedChoices = async (db: RelationalStore, runnerId: string): Promise<string | null> => (await first(db, choicesRead.bind(runnerId)))?.credential_choices ?? null;

const setChoice = write<[path: string, choice: string, runner: string]>({ name: 'runners.setCredentialChoice', sql:
  'UPDATE runners SET credential_choices = json_set(credential_choices, ?1, ?2), revision = revision + 1 WHERE id = ?3' });
const auditChoice = write<[id: string, runner: string, actor: string, agent: string, choice: string, revision: number, now: number]>({ name: 'runners.auditCredentialChoice', sql:
  'INSERT INTO runner_signin_audit(id,runner_id,actor_member,agent,choice,revision,at) VALUES (?1,?2,?3,?4,?5,?6,?7)' });

/** The two writes a sign-in change makes, in the batch of whichever commit carries it. */
export const signInChange = (change: { runner: string; actor: string; agent: string; choice: string; revision: number; now: number }): readonly Bound[] => [
  setChoice.bind(`$."${change.agent}"`, change.choice, change.runner),
  auditChoice.bind(crypto.randomUUID(), change.runner, change.actor, change.agent, change.choice, change.revision, change.now),
];

/** Sign-in changes commit with the actor guard and the revision the reader saw. Answers false when either no longer holds. */
export async function commitSignInChanges(db: RelationalStore, guard: { actor: string; runner: string; revision: number }, changes: readonly Bound[]): Promise<boolean> {
  try {
    await commit(db, adminAtRevision.bind(guard.actor, guard.runner, guard.revision), ...changes);
    return true;
  } catch (error) {
    if (refused(error, registrationRefused)) return false;
    throw error;
  }
}
