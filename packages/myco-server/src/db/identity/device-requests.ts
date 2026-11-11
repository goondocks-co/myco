import type { RelationalStore } from '../../core/adapters.js';
import { first, read, rows, write } from '../index.js';

export interface DeviceRequestRow {
  id: string;
  device_hash: string;
  machine_id: string;
  machine_name: string;
  os: string;
  source_ip: string;
  created_at: number;
  expires_at: number;
  decision: 'approved' | 'denied' | null;
  decided_by: string | null;
  subject: 'member' | 'runner';
  runner_name: string | null;
  runner_credential_choices: string;
  replacing_runner_id: string | null;
}

const targetsByName = read<[name: string], { id: string }>({ name: 'deviceRequests.runnersByName', sql:
  `SELECT id FROM runners WHERE name = ?1 AND state <> 'removed' LIMIT 2` });
const targetsByNameAndId = read<[name: string, id: string], { id: string }>({ name: 'deviceRequests.runnerByNameAndId', sql:
  `SELECT id FROM runners WHERE name = ?1 AND state <> 'removed' AND id = ?2 LIMIT 2` });
const known = read<[candidate: string], { one: number }>({ name: 'deviceRequests.candidateKnown', sql:
  `SELECT 1 AS one FROM device_requests WHERE candidate_hash = ?1
    UNION ALL SELECT 1 FROM runner_credentials WHERE token_hash = ?1 LIMIT 1` });

type Start = [id: string, deviceHash: string, userHash: string, machineId: string, machineName: string, os: string, source: string, now: number, expiresAt: number,
  interval: number, subject: string, runnerName: string | null, candidateHash: string | null, replacing: string | null, choices: string,
  pendingOffset: number, windowStart: number, startsOffset: number];
const start = write<Start, { id: string }>({ name: 'deviceRequests.start', sql:
  `INSERT INTO device_requests
    (id,device_hash,user_hash,machine_id,machine_name,os,source_ip,created_at,expires_at,interval_seconds,next_poll_at,subject,runner_name,candidate_hash,replacing_runner_id,runner_credential_choices)
    SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?8,?11,?12,?13,?14,?15 WHERE
      NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ?7 AND decision IS NULL AND expires_at > ?8 LIMIT 1 OFFSET ?16)
      AND NOT EXISTS (SELECT 1 FROM device_requests WHERE source_ip = ?7 AND created_at > ?17 LIMIT 1 OFFSET ?18) RETURNING id` });
const memberPoll = read<[hash: string], DeviceRequestRow & { used_at: number | null }>({ name: 'deviceRequests.memberPoll', sql:
  `SELECT d.*, a.used_at FROM device_requests d
    LEFT JOIN enrollment_authorities a ON a.id = d.id WHERE d.device_hash = ?1 AND d.subject = 'member'` });
const runnerPoll = read<[hash: string], DeviceRequestRow>({ name: 'deviceRequests.runnerPoll', sql:
  `SELECT * FROM device_requests WHERE device_hash = ?1 AND subject = 'runner'` });
const pace = write<[now: number, slowdown: number, hash: string], { slowed: number; interval_seconds: number }>({ name: 'deviceRequests.pace', sql:
  `UPDATE device_requests SET
    slowed = CASE WHEN next_poll_at > ?1 THEN 1 ELSE 0 END,
    interval_seconds = interval_seconds + CASE WHEN next_poll_at > ?1 THEN ?2 ELSE 0 END,
    next_poll_at = ?1 + (interval_seconds + CASE WHEN next_poll_at > ?1 THEN ?2 ELSE 0 END) * 1000
    WHERE device_hash = ?3 AND expires_at > ?1
    RETURNING slowed, interval_seconds` });
const byUserHash = read<[hash: string], DeviceRequestRow>({ name: 'deviceRequests.byUserHash', sql: 'SELECT * FROM device_requests WHERE user_hash = ?1' });
const claimant = read<[machine: string], { member_id: string }>({ name: 'deviceRequests.machineClaimant', sql: 'SELECT member_id FROM machine_claims WHERE machine_id = ?1' });

/** The runners of this name that are not removed (at most two), narrowed to one id when given. */
export async function runnersNamed(db: RelationalStore, name: string, runnerId?: string): Promise<string[]> {
  const found = await rows(db, runnerId === undefined ? targetsByName.bind(name) : targetsByNameAndId.bind(name, runnerId));
  return found.map(row => row.id);
}

/** True when a request or a runner credential already carries this candidate digest. */
export async function candidateDigestKnown(db: RelationalStore, digest: string): Promise<boolean> {
  return await first(db, known.bind(digest)) !== null;
}

/** What one request records when it starts, and the bounds it is admitted under. */
export interface DeviceRequestStart {
  id: string; deviceHash: string; userHash: string; machineId: string; machineName: string; os: string; source: string; now: number; expiresAt: number; intervalSeconds: number;
  runner: { name: string; candidateHash: string; replacingId: string | null; credentialChoices: string } | null;
  /** Pending requests one source may hold at once, and the requests it may start within the window. */
  limits: { pending: number; perWindow: number; windowStart: number };
}

/** Stores the request unless its source already holds `pending` undecided requests or started `perWindow` within the window; whether it was stored. */
export async function startDeviceRequest(db: RelationalStore, r: DeviceRequestStart): Promise<boolean> {
  const stored = await first(db, start.bind(r.id, r.deviceHash, r.userHash, r.machineId, r.machineName, r.os, r.source, r.now, r.expiresAt, r.intervalSeconds,
    r.runner === null ? 'member' : 'runner', r.runner?.name ?? null, r.runner?.candidateHash ?? null, r.runner?.replacingId ?? null, r.runner?.credentialChoices ?? '{}',
    r.limits.pending - 1, r.limits.windowStart, r.limits.perWindow - 1));
  return stored !== null;
}

/** The member request a device hash names with its enrollment's use, or null. */
export async function memberPollRow(db: RelationalStore, hash: string): Promise<(DeviceRequestRow & { used_at: number | null }) | null> {
  return first(db, memberPoll.bind(hash));
}

/** The runner request a device hash names, or null. */
export async function runnerPollRow(db: RelationalStore, hash: string): Promise<DeviceRequestRow | null> {
  return first(db, runnerPoll.bind(hash));
}

/** Advances the request's polling cadence, slowing it by `slowdown` seconds when it polls early; null when the request has expired. */
export async function pacePollRow(db: RelationalStore, hash: string, now: number, slowdown: number): Promise<{ slowed: number; interval_seconds: number } | null> {
  return first(db, pace.bind(now, slowdown, hash));
}

/** The request a user-code digest names, or null. */
export async function requestByUserHash(db: RelationalStore, hash: string): Promise<DeviceRequestRow | null> {
  return first(db, byUserHash.bind(hash));
}

/** The member claiming a machine, or null. */
export async function machineClaimant(db: RelationalStore, machineId: string): Promise<string | null> {
  return (await first(db, claimant.bind(machineId)))?.member_id ?? null;
}
