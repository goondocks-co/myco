import { write } from '../index.js';
import { renewingLeaseAuthority } from '../../core/worker-lease.js';

const contactAuthorities = [null,
  {worker:{kind:'member',tokenId:''},attempt:undefined}, {worker:{kind:'member',tokenId:''},attempt:''},
  {worker:{kind:'runner',runnerId:'',credentialId:''},attempt:undefined}, {worker:{kind:'runner',runnerId:'',credentialId:''},attempt:''},
] as const;
export const contactAuthorityIndex = (kind: 'member' | 'runner', attempt: string | undefined) => (kind === 'member' ? 1 : 3) + Number(attempt !== undefined);
export const workerContactUpsert = contactAuthorities.map((authority,i) => write<readonly unknown[]>({name:`claim.workerContactUpsert${['Open','Member','MemberAttempt','Runner','RunnerAttempt'][i]}`,sql:`WITH observation AS (
       SELECT ? AS credential_id, ? AS machine_id, ? AS offers, ? AS capabilities, ? AS reason, ? AS seen_at,
              ? AS explicit_offers, ? AS explicit_capabilities, ? AS explicit_reason, ? AS skip_revision
     ), machine_revision AS (
       SELECT COALESCE(MAX(w.updated_at), 0) AS revision
         FROM worker_contacts w CROSS JOIN member_credentials c ON c.id = w.credential_id CROSS JOIN observation o
        WHERE COALESCE(w.machine_id, c.machine_id) IS COALESCE(o.machine_id, (SELECT machine_id FROM member_credentials WHERE id = o.credential_id))
     )
     INSERT INTO worker_contacts (credential_id, machine_id, offers, capabilities, last_reason, last_seen_at, updated_at)
     SELECT credential_id, machine_id, offers, capabilities, reason, seen_at,
            CASE WHEN explicit_offers = 1 THEN MAX(seen_at, revision + 1) ELSE seen_at END
       FROM observation CROSS JOIN machine_revision
      WHERE (skip_revision IS NULL OR revision != skip_revision)${authority === null ? '' : ` AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=? AND id=? AND ${renewingLeaseAuthority(authority.worker,0,authority.attempt).sql})`}
     ON CONFLICT (credential_id) DO UPDATE SET
       machine_id = excluded.machine_id,
       offers = CASE WHEN (SELECT explicit_offers FROM observation) = 1 THEN excluded.offers ELSE worker_contacts.offers END,
       capabilities = CASE WHEN (SELECT explicit_capabilities FROM observation) = 1 THEN excluded.capabilities ELSE worker_contacts.capabilities END,
       last_reason = CASE WHEN (SELECT explicit_reason FROM observation) = 1 THEN excluded.last_reason ELSE worker_contacts.last_reason END,
       last_seen_at = MAX(worker_contacts.last_seen_at, excluded.last_seen_at),
       updated_at = CASE WHEN (SELECT explicit_offers FROM observation) = 1 THEN excluded.updated_at ELSE worker_contacts.updated_at END`}));
export const runnerContactUpsert = contactAuthorities.map((authority,i) => write<readonly unknown[]>({name:`claim.runnerContactUpsert${['Open','Member','MemberAttempt','Runner','RunnerAttempt'][i]}`,sql:`INSERT INTO runner_contacts (runner_id, machine_id, os, version, offers, capabilities, last_reason, last_seen_at, updated_at)
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE 1${authority === null ? '' : ` AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=? AND id=? AND ${renewingLeaseAuthority(authority.worker,0,authority.attempt).sql})`}
     ON CONFLICT (runner_id) DO UPDATE SET
       machine_id = COALESCE(excluded.machine_id, runner_contacts.machine_id),
       os = COALESCE(excluded.os, runner_contacts.os),
       version = COALESCE(excluded.version, runner_contacts.version),
       offers = CASE WHEN ? = 1 THEN excluded.offers ELSE runner_contacts.offers END,
       capabilities = CASE WHEN ? = 1 THEN excluded.capabilities ELSE runner_contacts.capabilities END,
       last_reason = COALESCE(excluded.last_reason, runner_contacts.last_reason),
       last_seen_at = MAX(runner_contacts.last_seen_at, excluded.last_seen_at),
       updated_at = CASE WHEN ? = 1 THEN MAX(excluded.updated_at, runner_contacts.updated_at + 1) ELSE runner_contacts.updated_at END
     WHERE excluded.last_seen_at - runner_contacts.last_seen_at >= ?
       OR (? = 1 AND excluded.offers IS NOT runner_contacts.offers)
       OR (? = 1 AND excluded.capabilities IS NOT runner_contacts.capabilities)
       OR (excluded.last_reason IS NOT NULL AND excluded.last_reason IS NOT runner_contacts.last_reason)
       OR (excluded.machine_id IS NOT NULL AND excluded.machine_id IS NOT runner_contacts.machine_id)
       OR (excluded.version IS NOT NULL AND excluded.version IS NOT runner_contacts.version)`}));
