/**
 * Routine store maintenance: optimizing the query planner's statistics and checking the store's integrity.
 *
 * One operation serves the clock's job and an owner's request. It reads the owner's cadence, claims the check
 * under a unique run id, asks the target's port to do the work, and records what the port found. The record is
 * the Deployment's latest outcome per check, held in its own key-value row (`schema_meta`); the cadence reads the
 * last claim's start, so a restart keeps it and a duplicate wake in one interval claims nothing.
 *
 * What a target can do is its port's declaration, never inferred: a check the port does not support is stated as
 * unavailable with its reason, and a measurement the target has no source for is unavailable rather than zero.
 *
 * Exclusivity is the claim. A claim carries an expiry past the port's own bound, and a completion lands only on
 * the claim that made it, so a run that outlived its claim can never overwrite a newer one.
 */
import type { ServerEnv } from './adapters.js';
import type { PowerState } from './power.js';
import { leafValues } from './settings.js';
import { classify } from '../telemetry.js';

export const MAINTENANCE_CHECKS = ['optimize', 'integrity'] as const;
export type MaintenanceCheck = (typeof MAINTENANCE_CHECKS)[number];

export const isMaintenanceCheck = (value: string): value is MaintenanceCheck =>
  (MAINTENANCE_CHECKS as readonly string[]).includes(value);

/** The job each check runs as. This registry of names is `jobs.ts`'s; the checks map onto it one to one. */
export const MAINTENANCE_JOB: Readonly<Record<MaintenanceCheck, string>> = {
  optimize: 'database-optimize',
  integrity: 'database-integrity-check',
};

/**
 * The owner's settings for each check and the interval bounds the dashboard offers.
 *
 * No leaf here has a declared default: an unset toggle or interval is not configured, and nothing runs. A value
 * outside the bounds or of the wrong type is reported as invalid rather than clamped or replaced.
 */
export const MAINTENANCE_SETTINGS: Readonly<Record<MaintenanceCheck, { enabled: string; interval: string; minHours: number; maxHours: number }>> = {
  optimize: { enabled: 'maintenance.auto_optimize', interval: 'maintenance.auto_optimize_interval_hours', minHours: 1, maxHours: 720 },
  integrity: { enabled: 'maintenance.auto_integrity_check', interval: 'maintenance.auto_integrity_check_interval_hours', minHours: 1, maxHours: 8760 },
};

/** At most this many findings are kept per outcome; the count beyond it is recorded, not the text. */
export const MAX_FINDINGS = 20;
/** At most this many characters of one finding are kept. */
export const MAX_FINDING_CHARS = 300;

const HOUR_MS = 3_600_000;
const META_KEY_PREFIX = 'maintenance.';

/** What a target measured, or why it could not. */
export type StoreMeasurement =
  | { name: MeasurementName; state: 'measured'; value: number; unit: 'bytes' }
  | { name: MeasurementName; state: 'unavailable'; reason: string };
export type MeasurementName = 'size' | 'reclaimable' | 'size_limit' | 'daily_quota';

/** What a port reports from one check. `findings` are the store's own words, one per problem. */
export interface PortResult {
  findings: string[];
  measurements: StoreMeasurement[];
  /** Set when the check stopped at its own bound before covering the store: what it did not reach. Recorded as a `timeout` failure. */
  incomplete?: string;
}

export type CheckSupport = { supported: true; label: string } | { supported: false; reason: string };

/**
 * One target's store maintenance.
 *
 * `claimMs` is how long a claim on this target must stay exclusive: the port's own bound on a check plus whatever
 * the target cannot interrupt once started. A target whose operation cannot be cancelled declares the lifetime
 * of the invocation that carries it, so exclusivity outlasts the work rather than a timer.
 */
export interface StoreMaintenancePort {
  support: Readonly<Record<MaintenanceCheck, CheckSupport>>;
  claimMs: Readonly<Record<MaintenanceCheck, number>>;
  run(check: MaintenanceCheck): Promise<PortResult>;
}

/** How an outcome ended. `failed` carries `errorClass`; `findings` means the store answered with problems. */
export type OutcomeState = 'running' | 'healthy' | 'findings' | 'failed';
export type MaintenanceTrigger = 'schedule' | 'owner';

/** The latest outcome of one check, as recorded. */
export interface MaintenanceOutcome {
  runId: string;
  check: MaintenanceCheck;
  trigger: MaintenanceTrigger;
  state: OutcomeState;
  startedAt: number;
  claimExpiresAt: number;
  finishedAt: number | null;
  /** The named cause when `state` is `failed`. */
  errorClass: string | null;
  findings: string[];
  /** Findings beyond `MAX_FINDINGS` that were not kept. */
  findingsOmitted: number;
  measurements: StoreMeasurement[];
  /** The power state the wake resolved, for a scheduled run. */
  powerState: PowerState | null;
}

/** Why a run did not start. */
export type MaintenanceRefusal = 'unsupported' | 'not_configured' | 'already_running' | 'not_due';

export type RunAnswer =
  | { outcome: 'ran'; record: MaintenanceOutcome }
  | { outcome: 'refused'; refusal: MaintenanceRefusal; reason: string };

/**
 * A check's cadence as the owner's leaves state it. `not_configured` names the unset leaf; `invalid` names the
 * leaf whose stored value the dashboard could not have written. Only `on` schedules anything.
 */
export type Cadence =
  | { state: 'on'; intervalHours: number }
  | { state: 'off' }
  | { state: 'not_configured'; leaf: string }
  | { state: 'invalid'; leaf: string; reason: string };

const metaKey = (check: MaintenanceCheck) => `${META_KEY_PREFIX}${check}`;

function parseLeaf(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return null; }
}

/** The owner's cadence for a check, read from the stored leaves alone. */
export async function cadenceOf(env: Pick<ServerEnv, 'db'>, check: MaintenanceCheck): Promise<Cadence> {
  const spec = MAINTENANCE_SETTINGS[check];
  const held = await leafValues(env.db, [spec.enabled, spec.interval]);
  const enabled = parseLeaf(held.get(spec.enabled));
  if (enabled === undefined) return { state: 'not_configured', leaf: spec.enabled };
  if (typeof enabled !== 'boolean') return { state: 'invalid', leaf: spec.enabled, reason: 'expected on or off' };
  if (!enabled) return { state: 'off' };
  const hours = parseLeaf(held.get(spec.interval));
  if (hours === undefined) return { state: 'not_configured', leaf: spec.interval };
  if (typeof hours !== 'number' || !Number.isInteger(hours) || hours < spec.minHours || hours > spec.maxHours) {
    return { state: 'invalid', leaf: spec.interval, reason: `expected a whole number of hours from ${spec.minHours} to ${spec.maxHours}` };
  }
  return { state: 'on', intervalHours: hours };
}

/** A recorded outcome. This module is the row's only writer, so an unreadable row is a fault to surface, never a check that never ran. */
function parseOutcome(raw: string | undefined): MaintenanceOutcome | null {
  if (raw === undefined) return null;
  const parsed = JSON.parse(raw) as MaintenanceOutcome;
  if (typeof parsed !== 'object' || parsed === null || typeof parsed.runId !== 'string') throw new Error('the recorded maintenance outcome is unreadable');
  return parsed;
}

/** The latest recorded outcome of a check, or null when it has never run. */
export async function latestOutcome(env: Pick<ServerEnv, 'db'>, check: MaintenanceCheck): Promise<MaintenanceOutcome | null> {
  const row = await env.db.prepare('SELECT value FROM schema_meta WHERE key = ?').bind(metaKey(check)).first<{ value: string }>();
  return parseOutcome(row?.value);
}

/** Whether the outcome still holds its claim: running, and inside its expiry. */
export const claimLive = (outcome: MaintenanceOutcome | null, now: number): boolean =>
  outcome !== null && outcome.state === 'running' && outcome.claimExpiresAt > now;

/** When a configured check next falls due: the last claim's start plus the interval, or now when it never ran. */
export function dueAt(cadence: Cadence, latest: MaintenanceOutcome | null, now: number): number | null {
  if (cadence.state !== 'on') return null;
  return latest === null ? now : latest.startedAt + cadence.intervalHours * HOUR_MS;
}

/**
 * Whether the clock should run this check now: supported, configured, not held by a live claim, and due.
 *
 * A run that failed consumed its interval exactly as one that succeeded did, so a check that cannot succeed at
 * this depth is not due again until its next interval and never holds the Deployment awake in between.
 */
export async function maintenanceDue(env: ServerEnv, check: MaintenanceCheck, now: number): Promise<boolean> {
  const port = env.storeMaintenance;
  if (port === undefined || !port.support[check].supported) return false;
  const cadence = await cadenceOf(env, check);
  if (cadence.state !== 'on') return false;
  const latest = await latestOutcome(env, check);
  if (claimLive(latest, now)) return false;
  const due = dueAt(cadence, latest, now);
  return due !== null && now >= due;
}

/** Whether any check is due, for the engine's depth assertion. */
export async function anyMaintenanceDue(env: ServerEnv, now: number): Promise<boolean> {
  if (env.storeMaintenance === undefined) return false;
  for (const check of MAINTENANCE_CHECKS) if (await maintenanceDue(env, check, now)) return true;
  return false;
}

/**
 * Claims a check for one run in a single conditional write.
 *
 * The row is replaced only when no live claim holds it and, for a scheduled run, only when the interval has
 * passed since the last claim's start. Two wakes, or a wake and an owner, racing for the same check therefore
 * claim it once: the loser's write matches no row and it reads back a run id that is not its own.
 */
async function claim(env: ServerEnv, record: MaintenanceOutcome, notBefore: number | null): Promise<boolean> {
  const key = metaKey(record.check);
  const cadenceGate = notBefore === null ? '' : ` AND CAST(json_extract(value, '$.startedAt') AS INTEGER) > ?`;
  await env.db.prepare(
    `INSERT OR REPLACE INTO schema_meta (key, value)
       SELECT ?, ?
        WHERE NOT EXISTS (
          SELECT 1 FROM schema_meta
           WHERE key = ?
             AND ((json_extract(value, '$.state') = 'running' AND CAST(json_extract(value, '$.claimExpiresAt') AS INTEGER) > ?)${cadenceGate === '' ? '' : ` OR (1${cadenceGate})`}))`,
  ).bind(key, JSON.stringify(record), key, record.startedAt, ...(notBefore === null ? [] : [notBefore])).run();
  const held = await latestOutcome(env, record.check);
  return held?.runId === record.runId;
}

/** Records a finished run, only over the claim that run made. Answers whether the record landed. */
async function complete(env: ServerEnv, record: MaintenanceOutcome): Promise<boolean> {
  const result = await env.db.prepare(
    `UPDATE schema_meta SET value = ? WHERE key = ? AND json_extract(value, '$.runId') = ?`,
  ).bind(JSON.stringify(record), metaKey(record.check), record.runId).run();
  return result.meta.changes === 1;
}

function boundFindings(findings: readonly string[]): { findings: string[]; findingsOmitted: number } {
  return {
    findings: findings.slice(0, MAX_FINDINGS).map((f) => (f.length > MAX_FINDING_CHARS ? `${f.slice(0, MAX_FINDING_CHARS)}…` : f)),
    findingsOmitted: Math.max(0, findings.length - MAX_FINDINGS),
  };
}

/**
 * Runs one check: the clock's job and the owner's request both come here.
 *
 * A scheduled run is refused unless the check is configured and due; an owner's run skips the cadence but never
 * the claim. The port's failure is recorded under its named class; nothing is recorded as healthy that the store
 * did not answer.
 */
export async function runMaintenance(
  env: ServerEnv, check: MaintenanceCheck, trigger: MaintenanceTrigger, now: number,
  options: { powerState?: PowerState; clock?: () => number } = {},
): Promise<RunAnswer> {
  const port = env.storeMaintenance;
  if (port === undefined) return { outcome: 'refused', refusal: 'unsupported', reason: 'this Deployment has no store maintenance' };
  const support = port.support[check];
  if (!support.supported) return { outcome: 'refused', refusal: 'unsupported', reason: support.reason };

  let notBefore: number | null = null;
  if (trigger === 'schedule') {
    const cadence = await cadenceOf(env, check);
    if (cadence.state !== 'on') {
      return { outcome: 'refused', refusal: 'not_configured', reason: cadence.state === 'off' ? `automatic ${check} is off` : `${cadence.leaf} is ${cadence.state === 'invalid' ? 'invalid' : 'not set'}` };
    }
    notBefore = now - cadence.intervalHours * HOUR_MS;
  }

  const record: MaintenanceOutcome = {
    runId: crypto.randomUUID(), check, trigger, state: 'running', startedAt: now,
    claimExpiresAt: now + port.claimMs[check], finishedAt: null, errorClass: null,
    findings: [], findingsOmitted: 0, measurements: [], powerState: options.powerState ?? null,
  };
  if (!(await claim(env, record, notBefore))) {
    const held = await latestOutcome(env, check);
    return claimLive(held, now)
      ? { outcome: 'refused', refusal: 'already_running', reason: `a ${check} run is already in progress` }
      : { outcome: 'refused', refusal: 'not_due', reason: `${check} is not due yet` };
  }

  const clock = options.clock ?? (() => Date.now());
  let finished: MaintenanceOutcome;
  try {
    const result = await port.run(check);
    const bounded = boundFindings(result.findings);
    finished = result.incomplete === undefined
      ? { ...record, ...bounded, measurements: result.measurements, finishedAt: clock(), state: result.findings.length === 0 ? 'healthy' : 'findings' }
      : { ...record, ...boundFindings([...result.findings, result.incomplete]), measurements: result.measurements, finishedAt: clock(), state: 'failed', errorClass: 'timeout' };
  } catch (err) {
    finished = { ...record, state: 'failed', finishedAt: clock(), errorClass: maintenanceErrorClass(err, env) };
  }
  // A completion that finds its claim replaced leaves the newer record standing; the answer still reports this run.
  await complete(env, finished);
  return { outcome: 'ran', record: finished };
}

/** A port's timeout, named so the recorded class says what happened rather than `unknown`. */
export class MaintenanceTimeoutError extends Error {
  constructor(readonly check: MaintenanceCheck, readonly afterMs: number) {
    super(`${check} did not finish within ${afterMs} ms`);
    this.name = 'MaintenanceTimeoutError';
  }
}

function maintenanceErrorClass(err: unknown, env: ServerEnv): string {
  if (err instanceof MaintenanceTimeoutError) return 'timeout';
  return classify(err, env.platform?.classifyError);
}

/** What an owner is told about one check. */
export interface MaintenanceCheckStatus {
  check: MaintenanceCheck;
  support: CheckSupport;
  cadence: Cadence;
  /** When the clock next runs it, or null when nothing is scheduled. */
  dueAt: number | null;
  running: boolean;
  latest: MaintenanceOutcome | null;
}

/** Every check's support, cadence and latest outcome, read fresh. */
export async function maintenanceStatus(env: ServerEnv, now: number): Promise<MaintenanceCheckStatus[]> {
  const port = env.storeMaintenance;
  return Promise.all(MAINTENANCE_CHECKS.map(async (check) => {
    const support: CheckSupport = port?.support[check] ?? { supported: false, reason: 'this Deployment has no store maintenance' };
    const cadence = await cadenceOf(env, check);
    const latest = await latestOutcome(env, check);
    return {
      check, support, cadence, latest, running: claimLive(latest, now),
      dueAt: support.supported ? dueAt(cadence, latest, now) : null,
    };
  }));
}
