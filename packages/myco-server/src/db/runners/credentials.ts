import type { RelationalStore } from '../../core/adapters.js';
import { MEMBER_LINEAGE_IDLE_MS } from '../../constants.js';
import { SQL_NOW_MS } from '../../core/run-deadline.js';
import { assertion, commitNamed, first, read, refusalCode, write, type Bound } from '../index.js';

export const RUNNER_LINEAGE_IDLE_MS = MEMBER_LINEAGE_IDLE_MS;

export type RunnerExpiry = 'live' | 'lapsed';

/**
 * The credential named by `alias` carries its runner's authority at `instant`: it is of the current epoch of a runner
 * that is not removed, it has not expired, and it is unrevoked — or its revocation is its own successor's first use,
 * which an already-admitted request on the predecessor completes under. Binds the instant once. Under `lapsed`, the
 * rotation route's admission, a credential past its expiry still holds within the lineage idle bound.
 */
export function runnerCredentialAuthority(alias: string, instant: string, expiry: RunnerExpiry = 'live'): string {
  return `EXISTS (SELECT 1 FROM runners authority_runner WHERE authority_runner.id = ${alias}.runner_id
      AND authority_runner.state <> 'removed' AND authority_runner.credential_epoch = ${alias}.epoch)
    AND ${expiry === 'live' ? `${alias}.expires_at` : `${alias}.issued_at + ${RUNNER_LINEAGE_IDLE_MS}`} > ${instant}
    AND (${alias}.revoked_at IS NULL OR (${alias}.revoked_by IS NULL AND EXISTS (SELECT 1 FROM runner_credentials authority_successor
      WHERE authority_successor.predecessor_id = ${alias}.id AND authority_successor.first_used_at IS NOT NULL
        AND authority_successor.revoked_at IS NULL AND authority_successor.runner_id = ${alias}.runner_id
        AND authority_successor.epoch = ${alias}.epoch)))`;
}

export interface RunnerAuthRow {
  schema_version: string;
  id: string | null;
  runner_id: string | null;
  epoch: number | null;
  issued_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  predecessor_id: string | null;
  first_used_at: number | null;
  state: 'enabled' | 'paused' | 'removed' | null;
  credential_epoch: number | null;
  name: string | null;
}

const authRead = read<[digest: string], RunnerAuthRow>({ name: 'runners.authenticate', sql: `SELECT s.value AS schema_version, c.id, c.runner_id, c.epoch, c.issued_at, c.expires_at, c.revoked_at,
    c.predecessor_id, c.first_used_at, r.state, r.credential_epoch, r.name
  FROM schema_meta s
  LEFT JOIN runner_credentials c ON c.token_hash = ?1
  LEFT JOIN runners r ON r.id = c.runner_id
  WHERE s.key = 'version'` });
/** One read: the schema version, the credential for the digest and its runner. */
export const runnerAuthRow = (db: RelationalStore, digest: string): Promise<RunnerAuthRow | null> => first(db, authRead.bind(digest));

const authorityRead = (expiry: RunnerExpiry) => read<[credential: string, runner: string, now: number], { id: string }>({ name: `runners.subjectAuthority${expiry === 'live' ? 'Live' : 'Lapsed'}`,
  sql: `SELECT c.id FROM runner_credentials c WHERE c.id = ?1 AND c.runner_id = ?2 AND ${runnerCredentialAuthority('c', '?3', expiry)}` });
const authorityReads: Readonly<Record<RunnerExpiry, ReturnType<typeof authorityRead>>> = { live: authorityRead('live'), lapsed: authorityRead('lapsed') };
export const runnerCredentialHoldsAuthority = async (db: RelationalStore, credentialId: string, runnerId: string, now: number, expiry: RunnerExpiry): Promise<boolean> =>
  await first(db, authorityReads[expiry].bind(credentialId, runnerId, now)) !== null;

/** A runner-admitted mutation lost its credential's authority; the JSON path SQLite reports stops the batch. */
export const RUNNER_WRITE_REFUSED = '$[myco_runner_write_refused]';
export const runnerWriteRefused = refusalCode('myco_runner_write_refused');
const writeAuthority = (expiry: RunnerExpiry) => assertion<[credential: string]>({ name: `runners.writeAuthority${expiry === 'live' ? 'Live' : 'Lapsed'}`, refusal: runnerWriteRefused,
  when: `EXISTS (SELECT 1 FROM runner_credentials c WHERE c.id = ?1 AND ${runnerCredentialAuthority('c', SQL_NOW_MS, expiry)})` });
const writeAuthorities: Readonly<Record<RunnerExpiry, ReturnType<typeof writeAuthority>>> = { live: writeAuthority('live'), lapsed: writeAuthority('lapsed') };
export const runnerWriteAuthority = (credentialId: string, expiry: RunnerExpiry): Bound => writeAuthorities[expiry].bind(credentialId);

const transferLeases = write<[successor: string, runner: string, predecessor: string]>({ name: 'runners.activateLeases', sql:
  `UPDATE agent_runs SET leased_runner_credential_id = ?1
    WHERE leased_runner_id = ?2 AND leased_runner_credential_id = ?3 AND status = 'running'
      AND EXISTS (SELECT 1 FROM runner_credentials successor JOIN runner_credentials predecessor ON predecessor.id = successor.predecessor_id
        WHERE successor.id = ?1 AND predecessor.id = ?3 AND successor.first_used_at IS NULL AND successor.revoked_at IS NULL
          AND successor.runner_id = predecessor.runner_id AND successor.epoch = predecessor.epoch)` });
const stampFirstUse = write<[now: number, successor: string]>({ name: 'runners.activateSuccessor', sql:
  `UPDATE runner_credentials SET first_used_at = ?1 WHERE id = ?2 AND first_used_at IS NULL AND revoked_at IS NULL` });
const revokePredecessor = write<[now: number, predecessor: string, runner: string, successor: string]>({ name: 'runners.revokeActivatedPredecessor', sql:
  `UPDATE runner_credentials SET revoked_at = ?1 WHERE id = ?2 AND runner_id = ?3 AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM runner_credentials s WHERE s.id = ?4 AND s.predecessor_id = ?2 AND s.first_used_at = ?1 AND s.revoked_at IS NULL)` });

/**
 * A successor's first use, once: its runner's live lease attribution moves to it, its first use is stamped and its
 * predecessor is revoked. Every step holds only while this successor is live and unused, so a successor another refresh
 * already replaced stamps nothing and revokes nothing.
 */
export async function commitSuccessorActivation(db: RelationalStore, activation: { successor: string; runner: string; predecessor: string; now: number }): Promise<void> {
  await commitNamed(db, {
    leases: transferLeases.bind(activation.successor, activation.runner, activation.predecessor),
    used: stampFirstUse.bind(activation.now, activation.successor),
    predecessor: revokePredecessor.bind(activation.now, activation.predecessor, activation.runner, activation.successor),
  });
}

interface BoundCandidate { id: string; runner_id: string; predecessor_id: string | null; expires_at: number; revoked_at: number | null }
const candidateRead = read<[digest: string], BoundCandidate>({ name: 'runners.boundCandidate', sql: `SELECT id, runner_id, predecessor_id, expires_at, revoked_at FROM runner_credentials WHERE token_hash = ?1` });
export const boundRunnerCandidate = (db: RelationalStore, digest: string): Promise<BoundCandidate | null> => first(db, candidateRead.bind(digest));

const predecessorLive = (credential: string, runner: string, now: string) => `EXISTS (SELECT 1 FROM runner_credentials p JOIN runners r ON r.id = p.runner_id
  WHERE p.id = ${credential} AND p.runner_id = ${runner} AND p.revoked_at IS NULL AND p.epoch = r.credential_epoch AND r.state <> 'removed'
    AND p.issued_at + ${RUNNER_LINEAGE_IDLE_MS} > ${now})`;
const retireBanked = write<[now: number, credential: string, runner: string]>({ name: 'runners.retireBankedSuccessor', sql:
  `UPDATE runner_credentials SET revoked_at = ?1 WHERE predecessor_id = ?2 AND revoked_at IS NULL AND first_used_at IS NULL AND ${predecessorLive('?2', '?3', '?1')}` });
const insertSuccessor = write<[successor: string, digest: string, now: number, expiresAt: number, credential: string, runner: string], { id: string }>({ name: 'runners.insertSuccessor', sql:
  `INSERT INTO runner_credentials (id, runner_id, token_hash, epoch, issued_at, expires_at, predecessor_id, lineage_root, first_used_at, revoked_at, revoked_by)
    SELECT ?1, p.runner_id, ?2, p.epoch, ?3, ?4, p.id, p.lineage_root, NULL, NULL, NULL FROM runner_credentials p WHERE p.id = ?5 AND ${predecessorLive('?5', '?6', '?3')}
    RETURNING id` });

/** Bind a staged successor, replacing any unused one the predecessor banked. Answers false when the predecessor no longer holds authority. */
export async function commitRunnerRotation(db: RelationalStore, rotation: { successor: string; digest: string; now: number; expiresAt: number; credential: string; runner: string }): Promise<boolean> {
  const { inserted } = await commitNamed(db, {
    banked: retireBanked.bind(rotation.now, rotation.credential, rotation.runner),
    inserted: insertSuccessor.bind(rotation.successor, rotation.digest, rotation.now, rotation.expiresAt, rotation.credential, rotation.runner),
  });
  return inserted.results.length === 1;
}

export interface RunnerReplay { credentialId: string; runnerId: string; epoch: number; issuedAt: number }
const replayRead = read<[digest: string], RunnerReplay>({ name: 'runners.detectReplay', sql: `SELECT p.id AS credentialId, p.runner_id AS runnerId, p.epoch, p.issued_at AS issuedAt FROM runner_credentials p
  JOIN runner_credentials s ON s.predecessor_id = p.id AND s.first_used_at IS NOT NULL AND s.runner_id = p.runner_id
  WHERE p.token_hash = ?1 AND p.revoked_at IS NOT NULL AND p.revoked_by IS NULL LIMIT 1` });
/** A presented digest whose credential a used successor already superseded: the evidence that two holders rotated one lineage. */
export const replayedRunnerCredential = (db: RelationalStore, digest: string): Promise<RunnerReplay | null> => first(db, replayRead.bind(digest));

const REPLAY_REVOKER = 'runner-lineage-replay';
const advanceEpoch = write<[runner: string, epoch: number], { id: string }>({ name: 'runners.replayAdvanceEpoch', sql:
  `UPDATE runners SET credential_epoch = credential_epoch + 1, revision = revision + 1 WHERE id = ?1 AND credential_epoch = ?2 AND state <> 'removed' RETURNING id` });
const revokeLineage = write<[now: number, runner: string, epoch: number]>({ name: 'runners.replayRevokeCredentials', sql:
  `UPDATE runner_credentials SET revoked_at = ?1, revoked_by = '${REPLAY_REVOKER}' WHERE runner_id = ?2 AND revoked_at IS NULL
    AND EXISTS (SELECT 1 FROM runners WHERE id = ?2 AND credential_epoch = ?3)` });
const auditReplay = write<[id: string, now: number, runner: string, epoch: number]>({ name: 'runners.replayAudit', sql:
  `INSERT INTO runner_audit (id, runner_id, actor_member, action, revision, at)
    SELECT ?1, id, NULL, 'lineage_replayed', revision, ?2 FROM runners WHERE id = ?3 AND credential_epoch = ?4
      AND NOT EXISTS (SELECT 1 FROM runner_audit WHERE runner_id = runners.id AND action = 'lineage_replayed' AND revision = runners.revision)` });

/** End every credential of a replayed runner, moving its epoch on. Answers how many epochs moved: 1, or 0 when another request already moved it. */
export async function commitRunnerLineageReplay(db: RelationalStore, replay: { runnerId: string; epoch: number }, now: number): Promise<number> {
  const { epoch } = await commitNamed(db, {
    epoch: advanceEpoch.bind(replay.runnerId, replay.epoch),
    credentials: revokeLineage.bind(now, replay.runnerId, replay.epoch + 1),
    audit: auditReplay.bind(crypto.randomUUID(), now, replay.runnerId, replay.epoch + 1),
  });
  return epoch.results.length;
}
