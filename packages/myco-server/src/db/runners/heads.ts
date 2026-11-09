import type { RelationalStore } from '../../core/adapters.js';
import { CONTACT_THROTTLE_MS } from '../../constants.js';
import { trigger, type Trigger } from '../ddl.js';
import { first, read, readSet, write } from '../index.js';
import type { CatchupFamily } from '../projections/family.js';

const MACHINE_HEAD_PROJECTION = 'machine_head';
const RUNNER_HEAD_PROJECTION = 'runner_head';
const CONTACT_PHASE = 'machineHeadContacts';
const CAPTURE_PHASE = 'machineHeadCaptures';
const RUNNER_PHASE = 'runnerHeads';

const everyPhase = (projection: string, phases: readonly string[]) =>
  `(SELECT COUNT(*) FROM projection_catchup WHERE projection='${projection}' AND done=1)=${phases.length}`;

/** Whether the machine heads hold every contact and capture that existed when they were built. */
export const MACHINE_HEADS_READY_SQL = everyPhase(MACHINE_HEAD_PROJECTION, [CONTACT_PHASE, CAPTURE_PHASE]);
export const RUNNER_HEADS_READY_SQL = everyPhase(RUNNER_HEAD_PROJECTION, [RUNNER_PHASE]);

const headValues = ['machine_id', 'revision', 'offers', 'offers_revision', 'offers_credential_id', 'latest_contact_at', 'latest_contact_credential_id', 'latest_run_at'].join(',');
const newerOffers = 'excluded.offers IS NOT NULL AND excluded.revision>machine_head.offers_revision';

/**
 * Merge one contact observation into its machine's head. Every value only moves forward, so the writers and the
 * catch-up can overlap in any order. Offers keep their own order, so a contact that carried no report never hides the
 * latest one that did. Liveness alone waits out the contact throttle; a new revision, report or run is written at once.
 */
const mergeContact = (select: string): string => `INSERT INTO machine_head(${headValues}) ${select}
  ON CONFLICT(machine_id) DO UPDATE SET
    offers=CASE WHEN ${newerOffers} THEN excluded.offers ELSE machine_head.offers END,
    offers_revision=CASE WHEN ${newerOffers} THEN excluded.revision ELSE machine_head.offers_revision END,
    offers_credential_id=CASE WHEN ${newerOffers} THEN excluded.offers_credential_id ELSE machine_head.offers_credential_id END,
    revision=MAX(machine_head.revision,excluded.revision),
    latest_contact_credential_id=CASE WHEN excluded.latest_contact_at>=COALESCE(machine_head.latest_contact_at,0) THEN excluded.latest_contact_credential_id ELSE machine_head.latest_contact_credential_id END,
    latest_contact_at=MAX(COALESCE(machine_head.latest_contact_at,0),excluded.latest_contact_at),
    latest_run_at=NULLIF(MAX(COALESCE(machine_head.latest_run_at,0),COALESCE(excluded.latest_run_at,0)),0)
  WHERE excluded.revision>machine_head.revision OR (${newerOffers}) OR COALESCE(excluded.latest_run_at,0)>COALESCE(machine_head.latest_run_at,0)
    OR excluded.latest_contact_at>=COALESCE(machine_head.latest_contact_at,0)+${CONTACT_THROTTLE_MS}`;

const contactMachine = (row: string): string => `COALESCE(${row}.machine_id,(SELECT c.machine_id FROM member_credentials c WHERE c.id=${row}.credential_id))`;
const readableOffers = (row: string): string => `CASE WHEN json_valid(${row}.offers) THEN ${row}.offers END`;

const contactSelect = (row: string, latestRun: string): string => `SELECT ${contactMachine(row)},${row}.updated_at,${readableOffers(row)},CASE WHEN ${readableOffers(row)} IS NULL THEN 0 ELSE ${row}.updated_at END,${row}.credential_id,${row}.last_seen_at,${row}.credential_id,${latestRun}`;

const mergeCapture = (select: string): string => `INSERT INTO machine_head(machine_id,revision,latest_capture_at) ${select}
  ON CONFLICT(machine_id) DO UPDATE SET latest_capture_at=excluded.latest_capture_at
  WHERE excluded.latest_capture_at>COALESCE(machine_head.latest_capture_at,0)`;

const runJson = (status: string, row: string, at: string): string =>
  `json_object('runId',${row}.id,'projectId',${row}.project_id,'task',${row}.task,'at',${at},'status',${status})`;
const order = (value: string): string => `(json_extract(${value},'$.at'),json_extract(${value},'$.runId'))`;
const later = (column: string): string => `runner_head.${column} IS NULL OR ${order(`excluded.${column}`)}>${order(`runner_head.${column}`)}`;

const attemptJson = (attempt: string): string => `json_object('runId',${attempt}.run_id,'projectId',${attempt}.project_id,
  'task',(SELECT task FROM agent_runs WHERE project_id=${attempt}.project_id AND id=${attempt}.run_id),'at',${attempt}.claimed_at,'status','attempted')`;

const mergeRunner = (column: string, runner: string, value: string, where: string): string => `INSERT INTO runner_head(runner_id,${column})
  SELECT ${runner},${value} WHERE ${where}
  ON CONFLICT(runner_id) DO UPDATE SET ${column}=excluded.${column} WHERE ${later(column)}`;

const heldTerminal = (run: string, runner: string): string =>
  `EXISTS(SELECT 1 FROM agent_run_attempts t WHERE t.project_id=${run}.project_id AND t.run_id=${run}.id AND t.attempt_id=${run}.dispatched_by AND t.runner_id=${runner})`;

export function machineHeadTriggers(): Trigger[] {
  const merge = (row: 'NEW') => `${mergeContact(`${contactSelect(row, `${row}.last_claim_at`)} WHERE ${contactMachine(row)} IS NOT NULL`)}`;
  const contact = ['updated_at', 'last_seen_at', 'offers', 'last_claim_at', 'machine_id'];
  return [
    trigger('machine_head_contact_insert', 'worker_contacts', 'INSERT', merge('NEW')),
    trigger('machine_head_contact_update', 'worker_contacts', `UPDATE OF ${contact.join(',')}`, merge('NEW'),
      contact.map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')),
    trigger('machine_head_capture_insert', 'machine_capture_heads', 'INSERT', mergeCapture('SELECT NEW.machine_id,0,NEW.last_received_at WHERE 1')),
    trigger('machine_head_capture_update', 'machine_capture_heads', 'UPDATE OF last_received_at', mergeCapture('SELECT NEW.machine_id,0,NEW.last_received_at WHERE 1'),
      'OLD.last_received_at IS NOT NEW.last_received_at'),
  ];
}

const seededColumns = ['last_attempted', 'last_completed', 'last_failed'] as const;
const namesRun = (column: string, row: string, run: string): string => `(json_extract(${column},'$.runId')=${row}.${run} AND json_extract(${column},'$.projectId')=${row}.project_id)`;
const unlinked = (column: string, row: string, run: string): string => `${column}=CASE WHEN ${namesRun(column, row, run)} THEN NULL ELSE ${column} END`;

export function runnerHeadTriggers(): Trigger[] {
  const terminal = (status: 'completed' | 'failed') => mergeRunner(`last_${status}`, 'NEW.leased_runner_id',
    runJson(`'${status}'`, 'NEW', 'NEW.completed_at'), `NEW.status='${status}'`);
  return [
    trigger('runner_head_attempt', 'agent_run_attempts', 'INSERT', mergeRunner('last_attempted', 'NEW.runner_id', attemptJson('NEW'), '1'),
      'NEW.runner_id IS NOT NULL'),
    trigger('runner_head_terminal', 'agent_runs', 'UPDATE OF status', [terminal('completed'), terminal('failed')],
      `NEW.leased_runner_id IS NOT NULL AND NEW.status IN ('completed','failed') AND OLD.status IS NOT NEW.status AND ${heldTerminal('NEW', 'NEW.leased_runner_id')}`),
    trigger('runner_head_run_delete', 'agent_runs', 'DELETE', `UPDATE runner_head SET ${seededColumns.map(column => unlinked(column, 'OLD', 'id')).join(',')}
      WHERE runner_id=OLD.leased_runner_id AND (${seededColumns.map(column => namesRun(column, 'OLD', 'id')).join(' OR ')})`, 'OLD.leased_runner_id IS NOT NULL'),
    trigger('runner_head_attempt_delete', 'agent_run_attempts', 'DELETE', `UPDATE runner_head SET last_attempted=NULL
      WHERE runner_id=OLD.runner_id AND ${namesRun('last_attempted', 'OLD', 'run_id')}`, 'OLD.runner_id IS NOT NULL'),
  ];
}

/** The newest terminal run of `status` the runner actually drove, read from history for the catch-up and while it builds. */
export const runnerTerminalHistory = (status: 'completed' | 'failed', runner: string): string => `(SELECT ${runJson(`'${status}'`, 'h', 'h.completed_at')}
    FROM agent_runs h INDEXED BY idx_runner_run_terminal WHERE h.leased_runner_id=${runner} AND h.status='${status}' AND ${heldTerminal('h', runner)}
    ORDER BY h.completed_at DESC,h.id DESC LIMIT 1)`;
/** The newest attempt the runner claimed, from its attempt history. */
export const runnerAttemptHistory = (runner: string): string => `(SELECT ${attemptJson('h')} FROM agent_run_attempts h WHERE h.runner_id=${runner}
    ORDER BY h.claimed_at DESC,h.attempt_id DESC LIMIT 1)`;

const reconcileContacts = write<[keys: string]>({ name: 'runnerHeads.reconcileContacts', sql:
  mergeContact(`${contactSelect('w', `NULLIF(MAX(COALESCE(w.last_claim_at,0),COALESCE((SELECT MAX(r.started_at) FROM agent_runs r INDEXED BY idx_agent_runs_worker_started WHERE r.leased_by=w.credential_id),0)),0)`)}
    FROM (SELECT json_extract(value,'$[0]') AS credential_id FROM json_each(?1)) k CROSS JOIN worker_contacts w ON w.credential_id=k.credential_id
    WHERE ${contactMachine('w')} IS NOT NULL`) });
const reconcileCaptures = write<[keys: string]>({ name: 'runnerHeads.reconcileCaptures', sql:
  mergeCapture(`SELECT h.machine_id,0,h.last_received_at FROM (SELECT json_extract(value,'$[0]') AS machine_id,json_extract(value,'$[1]') AS agent_json FROM json_each(?1)) k
    CROSS JOIN machine_capture_heads h ON h.machine_id=k.machine_id AND h.agent_json=k.agent_json WHERE 1`) });

const pick = (column: string): string => `CASE WHEN ${later(column)} THEN excluded.${column} ELSE runner_head.${column} END`;
const reconcileRunners = write<[keys: string]>({ name: 'runnerHeads.reconcileRunners', sql: `INSERT INTO runner_head(runner_id,${seededColumns.join(',')},seeded)
  SELECT r.id,${runnerAttemptHistory('r.id')},${runnerTerminalHistory('completed', 'r.id')},${runnerTerminalHistory('failed', 'r.id')},1
    FROM (SELECT json_extract(value,'$[0]') AS id FROM json_each(?1)) k CROSS JOIN runners r ON r.id=k.id WHERE 1
  ON CONFLICT(runner_id) DO UPDATE SET ${seededColumns.map(column => `${column}=${pick(column)}`).join(',')},seeded=1` });

const clearMachineHeads = write<[]>({ name: 'runnerHeads.clearMachines', sql: 'DELETE FROM machine_head' });
const clearRunnerHeads = write<[]>({ name: 'runnerHeads.clearRunners', sql: 'DELETE FROM runner_head' });

export const MACHINE_HEAD_CATCHUP = {
  projection: MACHINE_HEAD_PROJECTION,
  reset: () => [clearMachineHeads.bind()],
  phases: {
    [CONTACT_PHASE]: { source: { table: 'worker_contacts', columns: ['credential_id'], unique: true }, reconcile: [reconcileContacts] },
    [CAPTURE_PHASE]: { source: { table: 'machine_capture_heads', columns: ['machine_id', 'agent_json'], unique: true }, reconcile: [reconcileCaptures] },
  },
} as const satisfies CatchupFamily;

export const RUNNER_HEAD_CATCHUP = {
  projection: RUNNER_HEAD_PROJECTION,
  reset: () => [clearRunnerHeads.bind()],
  phases: { [RUNNER_PHASE]: { source: { table: 'runners', columns: ['id'], unique: true }, reconcile: [reconcileRunners] } },
} as const satisfies CatchupFamily;

const phaseSeed = (projection: string, phase: string, table: string): string =>
  `INSERT INTO projection_catchup(projection,phase,done) SELECT '${projection}','${phase}',NOT EXISTS(SELECT 1 FROM ${table}) ON CONFLICT DO NOTHING`;

/** The step's frozen text: both heads, their triggers and their catch-up phases. Pinned to the step so the triggers keep the merge the catch-up runs. */
export function headSchemaStatements(): string[] {
  return [
    `ALTER TABLE worker_contacts ADD COLUMN last_claim_at INTEGER`,
    `CREATE TABLE IF NOT EXISTS machine_head(machine_id TEXT PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 0,offers TEXT,offers_revision INTEGER NOT NULL DEFAULT 0,offers_credential_id TEXT,
      latest_contact_at INTEGER,latest_contact_credential_id TEXT,latest_run_at INTEGER,latest_capture_at INTEGER,harness_revision INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
    `CREATE TABLE IF NOT EXISTS runner_head(runner_id TEXT PRIMARY KEY,last_attempted TEXT,last_completed TEXT,last_failed TEXT,seeded INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID`,
    ...machineHeadTriggers().map(entry => entry.sql),
    ...runnerHeadTriggers().map(entry => entry.sql),
    phaseSeed(MACHINE_HEAD_PROJECTION, CONTACT_PHASE, 'worker_contacts'),
    phaseSeed(MACHINE_HEAD_PROJECTION, CAPTURE_PHASE, 'machine_capture_heads'),
    phaseSeed(RUNNER_HEAD_PROJECTION, RUNNER_PHASE, 'runners'),
  ];
}

interface MachineHeadRow {
  machine_id: string;
  revision: number;
  offers: string | null;
  latest_contact_at: number | null;
  latest_run_at: number | null;
  latest_capture_at: number | null;
}
const HEAD_COLUMNS = 'machine_id,revision,offers,latest_contact_at,latest_run_at,latest_capture_at';

const oneHead = read<[machine: string], MachineHeadRow>({ name: 'runnerHeads.machine', sql: `SELECT ${HEAD_COLUMNS} FROM machine_head WHERE machine_id=?1` });
const pageHeads = read<[machines: string], MachineHeadRow>({ name: 'runnerHeads.machines', sql: `SELECT ${HEAD_COLUMNS} FROM machine_head WHERE machine_id IN (SELECT value FROM json_each(?1))` });
const contactedHeads = read<[], MachineHeadRow>({ name: 'runnerHeads.contacted', sql: `SELECT ${HEAD_COLUMNS} FROM machine_head WHERE latest_contact_at IS NOT NULL` });
const machineReady = read<[], { ready: number }>({ name: 'runnerHeads.machineReady', sql: `SELECT ${MACHINE_HEADS_READY_SQL} AS ready` });

export const machineHead = (db: RelationalStore, machineId: string): Promise<MachineHeadRow | null> => first(db, oneHead.bind(machineId));

/** The page's machine heads and whether they are complete, in one snapshot. */
export async function machineHeadPage(db: RelationalStore, machineIds: readonly string[]) {
  const [heads, [ready]] = await readSet(db, pageHeads.bind(JSON.stringify(machineIds)), machineReady.bind());
  return { heads, building: ready?.ready !== 1 };
}

/** Every machine that has been heard from, newest report included. */
export const contactedMachineHeads = async (db: RelationalStore): Promise<MachineHeadRow[]> => (await readSet(db, contactedHeads.bind()))[0];
