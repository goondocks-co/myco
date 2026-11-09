import type { RelationalStore } from './adapters.js';
import {
  HARNESS_HEALTH_STATES, MAX_HARNESS_ACTION_CHARS, MAX_HARNESS_ID_CHARS, MAX_PROVISIONED_HARNESSES, MAX_HARNESS_DEPLOYMENT_CHARS,
  type ProvisionedHarnessFact, type ProvisionedHarnessReport,
  HARNESS_SILENT_MS, HARNESS_RUN_CAPTURE_MARGIN_MS,
} from '@goondocks/myco-shared/harness-health';
import {
  commitHarnessReport,
  harnessAttentionRows,
  harnessHealthRows,
  machineHarnessCaptureSince,
  machineHarnessState,
  trustConfirmationCapture,
  type HarnessReportRow,
  type HarnessRowWrite,
} from '../db/runners/harness-health.js';
import { sha256Hex } from '../hash.js';

type StoredHarnessFact = ProvisionedHarnessFact & { sinceAt: number; trustEpoch: number };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).every((key) => fields.includes(key));

/** A bounded machine snapshot with identifier harness names and single-line actions. */
export function parseProvisionedHarnessReport(value: unknown): ProvisionedHarnessReport | null {
  if (!isObject(value) || !knownFields(value, ['harnesses']) || !Array.isArray(value.harnesses) || value.harnesses.length > MAX_PROVISIONED_HARNESSES) return null;
  const harnesses: ProvisionedHarnessFact[] = [];
  const ids = new Set<string>();
  for (const item of value.harnesses) {
    if (!isObject(item) || !knownFields(item, ['id', 'provisioned', 'state', 'action', 'ranAt', 'hookRepairAt', 'toolsDeployment', 'activityScope'])
      || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_HARNESS_ID_CHARS
      || !/^[A-Za-z0-9._-]+$/.test(item.id) || ids.has(item.id)
      || item.provisioned !== true || !HARNESS_HEALTH_STATES.includes(item.state as typeof HARNESS_HEALTH_STATES[number])
      || (item.activityScope !== undefined && item.activityScope !== 'deployment' && item.activityScope !== 'unavailable')
      || (item.activityScope === 'unavailable' && item.ranAt !== undefined)
      || (item.ranAt !== undefined && (!Number.isSafeInteger(item.ranAt) || (item.ranAt as number) < 0))
      || (item.hookRepairAt !== undefined && (item.state !== 'trust_required' || !Number.isSafeInteger(item.hookRepairAt) || (item.hookRepairAt as number) < 0))) return null;
    const action = item.action;
    if (item.state === 'ready' || item.state === 'held_elsewhere' ? action !== undefined : typeof action !== 'string' || action.length === 0 || action.length > MAX_HARNESS_ACTION_CHARS || /[\x00-\x1f\x7f]/.test(action) || action.trim() !== action) return null;
    const toolsDeployment = item.toolsDeployment;
    if (item.state === 'held_elsewhere' ? typeof toolsDeployment !== 'string' || toolsDeployment.length === 0 || toolsDeployment.length > MAX_HARNESS_DEPLOYMENT_CHARS || /[\x00-\x20\x7f]/.test(toolsDeployment) : toolsDeployment !== undefined) return null;
    ids.add(item.id);
    harnesses.push({ id: item.id, provisioned: true, state: item.state as ProvisionedHarnessFact['state'],
      ...(item.activityScope === undefined ? {} : { activityScope: item.activityScope as ProvisionedHarnessFact['activityScope'] }),
      ...(typeof toolsDeployment === 'string' ? { toolsDeployment } : {}), ...(typeof item.ranAt === 'number' ? { ranAt: item.ranAt } : {}), ...(typeof item.hookRepairAt === 'number' ? { hookRepairAt: item.hookRepairAt } : {}), ...(typeof action === 'string' ? { action } : {}) });
  }
  return { harnesses };
}

/** A stored row as a fact. Only rows the report writer admitted reach this table. */
function storedFact(row: HarnessReportRow): StoredHarnessFact {
  return {
    id: row.harness, provisioned: true, state: row.state as ProvisionedHarnessFact['state'], sinceAt: row.since_at, trustEpoch: row.trust_epoch,
    ...(row.activity_scope === null ? {} : { activityScope: row.activity_scope as ProvisionedHarnessFact['activityScope'] }),
    ...(row.tools_deployment === null ? {} : { toolsDeployment: row.tools_deployment }),
    ...(row.ran_at === null ? {} : { ranAt: row.ran_at }),
    ...(row.hook_repair_at === null ? {} : { hookRepairAt: row.hook_repair_at }),
    ...(row.action === null ? {} : { action: row.action }),
  };
}

/** Rows arrive in machine and report order; a machine's facts stay together. */
function factsByMachine(rows: readonly HarnessReportRow[]): Array<{ machineId: string; harnesses: StoredHarnessFact[] }> {
  const machines = new Map<string, StoredHarnessFact[]>();
  for (const row of rows) machines.set(row.machine_id, [...(machines.get(row.machine_id) ?? []), storedFact(row)]);
  return Array.from(machines, ([machineId, harnesses]) => ({ machineId, harnesses }));
}

const captureConfigured = (state: ProvisionedHarnessFact['state']): state is 'ready' | 'held_elsewhere' => state === 'ready' || state === 'held_elsewhere';

const REPORT_ATTEMPTS = 3;

/** A report that kept losing to concurrent reports for its machine; it changed nothing, and the next report settles the state. */
export class HarnessReportContended extends Error {
  constructor() { super(`the harness report lost to ${REPORT_ATTEMPTS} concurrent reports for its machine`); }
}

/** What the machine says it can do, apart from when it last ran: an unchanged hash with unchanged trust state leaves the row alone. */
const capabilityHash = (fact: ProvisionedHarnessFact): Promise<string> => sha256Hex(JSON.stringify([fact.id, fact.state, fact.action ?? null, fact.hookRepairAt ?? null, fact.toolsDeployment ?? null, fact.activityScope ?? null]));

/**
 * The trust transition of one reported harness. A machine that reported trust wanted and now reports capture configured
 * stays in trust_required until a qualifying session start proves it. A new repair, or a confirmation followed by a new
 * trust report, starts a new epoch. A replayed report repeats the state and cannot reset an older epoch.
 */
function nextFact(fact: ProvisionedHarnessFact, previous: StoredHarnessFact | undefined, lastCapture: number, now: number): StoredHarnessFact {
  if (fact.state === 'trust_required' && fact.hookRepairAt !== undefined && fact.hookRepairAt !== previous?.hookRepairAt) return { ...fact, sinceAt: now, trustEpoch: (previous?.trustEpoch ?? 0) + 1 };
  if (previous?.state === 'trust_required' && captureConfigured(fact.state) && lastCapture <= previous.sinceAt) return { ...previous, ranAt: fact.ranAt, activityScope: fact.activityScope };
  if (previous?.state === 'trust_required' && fact.state === 'trust_required' && fact.hookRepairAt === undefined && lastCapture > previous.sinceAt) return { ...fact, sinceAt: now, trustEpoch: previous.trustEpoch + 1 };
  const epoch = previous?.trustEpoch ?? 0;
  return { ...fact, sinceAt: previous?.state === fact.state ? previous.sinceAt : now, trustEpoch: fact.state === 'trust_required' && previous?.state !== 'trust_required' ? epoch + 1 : epoch };
}

const toWrite = async (fact: StoredHarnessFact): Promise<HarnessRowWrite> => ({
  harness: fact.id, state: fact.state, action: fact.action ?? null, ranAt: fact.ranAt ?? null, hookRepairAt: fact.hookRepairAt ?? null,
  toolsDeployment: fact.toolsDeployment ?? null, activityScope: fact.activityScope ?? null, sinceAt: fact.sinceAt, trustEpoch: fact.trustEpoch,
  capabilityHash: await capabilityHash(fact),
});

/**
 * One writer for current machine harness facts. Each pass reads the machine's rows at a report revision and commits only
 * while that revision stands, so two concurrent reports cannot overwrite each other's trust state. A loser re-reads and re-derives.
 */
export async function recordProvisionedHarnessReport(db: RelationalStore, machineId: string, report: ProvisionedHarnessReport, now: number): Promise<void> {
  for (let attempt = 0; attempt < REPORT_ATTEMPTS; attempt += 1) {
    const { revision, rows } = await machineHarnessState(db, machineId);
    const prior = new Map(rows.map((row) => [row.harness, storedFact(row)]));
    const trustSince = report.harnesses.flatMap((fact) => {
      const previous = prior.get(fact.id);
      return previous?.state === 'trust_required' && (captureConfigured(fact.state) || fact.state === 'trust_required') ? [previous.sinceAt] : [];
    });
    const lastCapture = new Map<string, number>();
    if (trustSince.length > 0) {
      const oldestTrust = trustSince.reduce((oldest, at) => Math.min(oldest, at), Infinity);
      for (const entry of await machineHarnessCaptureSince(db, machineId, oldestTrust)) lastCapture.set(entry.agent, entry.at);
    }
    const harnesses = await Promise.all(report.harnesses.map((fact) => toWrite(nextFact(fact, prior.get(fact.id), lastCapture.get(fact.id) ?? 0, now))));
    if (await commitHarnessReport(db, machineId, revision, harnesses, now)) return;
  }
  throw new HarnessReportContended();
}

const HOUR_MS = 60 * 60_000;
/** Machine activity must be recent enough to distinguish a quiet harness from an idle machine. */
export const MACHINE_ACTIVE_MS = HOUR_MS;

export type HarnessAttentionFact =
  | { kind: 'harness_needs_repair'; machineId: string; machineName: string | null; harness: string; state: Exclude<ProvisionedHarnessFact['state'], 'ready' | 'held_elsewhere'>; action: string; since: number }
  | { kind: 'harness_capture_silent'; machineId: string; machineName: string | null; harness: string; lastCapturedAt: number; lastMachineActivityAt: number };

/** Combine the member's current provisioned state with Deployment-owned capture and contact times. */
export async function provisionedHarnessAttention(db: RelationalStore, now: number): Promise<HarnessAttentionFact[]> {
  const [rawReports, rawSessions, machineSessions, contacts, claims] = await harnessAttentionRows(db, now - MACHINE_ACTIVE_MS);
  const reports = factsByMachine(rawReports);
  const sessions = rawSessions.filter((row): row is typeof row & { at: number } => row.at !== null);
  const machineNames = new Map(claims.map((row) => [row.machine_id, row.label]));
  const captured = new Map(sessions.map((row) => [`${row.machine_id}\0${row.agent}`, row.at]));
  const trustSince = reports.flatMap((report) => report.harnesses.filter((harness) => harness.state === 'trust_required').map((harness) => harness.sinceAt));
  const oldestTrust = trustSince.reduce((oldest, at) => Math.min(oldest, at), Infinity);
  const trustCaptures = trustSince.length === 0 ? [] : await trustConfirmationCapture(db, oldestTrust);
  const confirmedTrust = new Map(trustCaptures.map((row) => [`${row.machine_id}\0${row.agent}`, row.at]));
  const machineActivity = new Map<string, number>();
  for (const row of machineSessions) machineActivity.set(row.machine_id, Math.max(machineActivity.get(row.machine_id) ?? 0, row.at));
  for (const row of contacts) machineActivity.set(row.machine_id, Math.max(machineActivity.get(row.machine_id) ?? 0, row.at));
  for (const report of reports) {
    for (const harness of report.harnesses) {
      if (harness.activityScope === 'deployment' && harness.ranAt !== undefined) machineActivity.set(report.machineId, Math.max(machineActivity.get(report.machineId) ?? 0, harness.ranAt));
    }
  }
  const facts: HarnessAttentionFact[] = [];
  for (const report of reports) {
    for (const harness of report.harnesses) {
      const base = { machineId: report.machineId, machineName: machineNames.get(report.machineId) ?? null, harness: harness.id };
      const lastCapturedAt = captured.get(`${report.machineId}\0${harness.id}`) ?? null;
      const trustConfirmed = harness.state === 'trust_required' && (confirmedTrust.get(`${report.machineId}\0${harness.id}`) ?? 0) > harness.sinceAt;
      if (!captureConfigured(harness.state) && !trustConfirmed) {
        facts.push({ ...base, kind: 'harness_needs_repair', state: harness.state, action: harness.action!, since: harness.sinceAt });
        continue;
      }
      const lastMachineActivityAt = machineActivity.get(report.machineId) ?? null;
      if (harness.activityScope === 'deployment' && harness.ranAt !== undefined && lastCapturedAt !== null && lastMachineActivityAt !== null
        && now - lastCapturedAt > HARNESS_SILENT_MS && now - lastMachineActivityAt <= MACHINE_ACTIVE_MS
        && harness.ranAt > lastCapturedAt + HARNESS_RUN_CAPTURE_MARGIN_MS) {
        facts.push({ ...base, kind: 'harness_capture_silent', lastCapturedAt, lastMachineActivityAt });
      }
    }
  }
  return facts;
}

/** Current harness wiring, named by its claimed machine, including informational tool destinations. */
export async function provisionedHarnessHealth(db: RelationalStore): Promise<Array<ProvisionedHarnessFact & { machineId: string; machineName: string | null }>> {
  const [rawReports, claims] = await harnessHealthRows(db);
  const names = new Map(claims.map((claim) => [claim.machine_id, claim.label]));
  return factsByMachine(rawReports).flatMap((report) => report.harnesses.map(({ sinceAt: _sinceAt, trustEpoch: _trustEpoch, ...fact }) => ({ ...fact, machineId: report.machineId, machineName: names.get(report.machineId) ?? null })));
}
