import type { RelationalStore } from './adapters.js';
import {
  HARNESS_HEALTH_STATES, MAX_HARNESS_ACTION_CHARS, MAX_HARNESS_ID_CHARS, MAX_PROVISIONED_HARNESSES,
  type ProvisionedHarnessFact, type ProvisionedHarnessReport,
} from '@goondocks/myco-shared/harness-health';
import {
  claimedMachineNames, machineHarnessCaptureSince, machineHarnessReport, provisionedHarnessReportRows,
  latestHarnessCapture, recentMachineCapture, trustConfirmationCapture, workerMachineActivity,
} from '../read/harness-health.js';

type StoredHarnessFact = ProvisionedHarnessFact & { sinceAt: number };
type StoredReport = { machineId: string; harnesses: StoredHarnessFact[]; reportedAt: number };

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const knownFields = (value: Record<string, unknown>, fields: readonly string[]): boolean => Object.keys(value).every((key) => fields.includes(key));

/** A bounded machine snapshot with identifier harness names and single-line actions. */
export function parseProvisionedHarnessReport(value: unknown): ProvisionedHarnessReport | null {
  if (!isObject(value) || !knownFields(value, ['harnesses']) || !Array.isArray(value.harnesses) || value.harnesses.length > MAX_PROVISIONED_HARNESSES) return null;
  const harnesses: ProvisionedHarnessFact[] = [];
  const ids = new Set<string>();
  for (const item of value.harnesses) {
    if (!isObject(item) || !knownFields(item, ['id', 'provisioned', 'state', 'action', 'ranAt', 'hookRepairAt'])
      || typeof item.id !== 'string' || item.id.length === 0 || item.id.length > MAX_HARNESS_ID_CHARS
      || !/^[A-Za-z0-9._-]+$/.test(item.id) || ids.has(item.id)
      || item.provisioned !== true || !HARNESS_HEALTH_STATES.includes(item.state as typeof HARNESS_HEALTH_STATES[number])
      || (item.ranAt !== undefined && (!Number.isSafeInteger(item.ranAt) || (item.ranAt as number) < 0))
      || (item.hookRepairAt !== undefined && (item.state !== 'trust_required' || !Number.isSafeInteger(item.hookRepairAt) || (item.hookRepairAt as number) < 0))) return null;
    const action = item.action;
    if (item.state === 'ready' ? action !== undefined : typeof action !== 'string' || action.length === 0 || action.length > MAX_HARNESS_ACTION_CHARS || /[\x00-\x1f\x7f]/.test(action) || action.trim() !== action) return null;
    ids.add(item.id);
    harnesses.push({ id: item.id, provisioned: true, state: item.state as ProvisionedHarnessFact['state'],
      ...(typeof item.ranAt === 'number' ? { ranAt: item.ranAt } : {}), ...(typeof item.hookRepairAt === 'number' ? { hookRepairAt: item.hookRepairAt } : {}), ...(typeof action === 'string' ? { action } : {}) });
  }
  return { harnesses };
}

function storedFacts(raw: string): StoredHarnessFact[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('stored harness report is not a list');
  const report = parseProvisionedHarnessReport({ harnesses: parsed.map((item: unknown) => {
    if (!isObject(item)) return item;
    const { sinceAt: _sinceAt, ...fact } = item;
    return fact;
  }) });
  if (report === null || parsed.some((item) => !isObject(item) || !Number.isSafeInteger(item.sinceAt) || (item.sinceAt as number) < 0)) throw new Error('stored harness report is invalid');
  return report.harnesses.map((fact, i) => ({ ...fact, sinceAt: (parsed[i] as { sinceAt: number }).sinceAt }));
}

/** One writer for current machine harness facts; a repeated state retains the instant it first needed attention. */
export async function recordProvisionedHarnessReport(db: RelationalStore, machineId: string, report: ProvisionedHarnessReport, now: number): Promise<void> {
  const raw = await machineHarnessReport(db, machineId);
  const prior = new Map((raw === null ? [] : storedFacts(raw)).map((fact) => [fact.id, fact]));
  const trustSince = report.harnesses.flatMap((fact) => {
    const previous = prior.get(fact.id);
    return previous?.state === 'trust_required' && (fact.state === 'ready' || fact.state === 'trust_required') ? [previous.sinceAt] : [];
  });
  const lastCapture = new Map<string, number>();
  if (trustSince.length > 0) {
    const oldestTrust = trustSince.reduce((oldest, at) => Math.min(oldest, at), Infinity);
    for (const entry of await machineHarnessCaptureSince(db, machineId, oldestTrust)) lastCapture.set(entry.agent, entry.at);
  }
  const harnesses = report.harnesses.map((fact): StoredHarnessFact => {
    const previous = prior.get(fact.id);
    if (fact.state === 'trust_required' && fact.hookRepairAt !== undefined && fact.hookRepairAt !== previous?.hookRepairAt) return { ...fact, sinceAt: now };
    if (previous?.state === 'trust_required' && fact.state === 'ready' && (lastCapture.get(fact.id) ?? 0) <= previous.sinceAt) {
      return { ...previous, ranAt: fact.ranAt };
    }
    if (previous?.state === 'trust_required' && fact.state === 'trust_required' && (lastCapture.get(fact.id) ?? 0) > previous.sinceAt) return { ...fact, sinceAt: now };
    return { ...fact, sinceAt: previous?.state === fact.state ? previous.sinceAt : now };
  });
  await db.prepare(`INSERT INTO machine_harness_reports (machine_id, harnesses, reported_at) VALUES (?, ?, ?)
    ON CONFLICT (machine_id) DO UPDATE SET harnesses = excluded.harnesses, reported_at = excluded.reported_at`)
    .bind(machineId, JSON.stringify(harnesses), now).run();
}

/** Every machine's latest report; malformed stored evidence makes the Health check unavailable. */
export async function readProvisionedHarnessReports(db: RelationalStore): Promise<StoredReport[]> {
  const rows = await provisionedHarnessReportRows(db);
  return rows.map((row) => ({ machineId: row.machine_id, harnesses: storedFacts(row.harnesses), reportedAt: row.reported_at }));
}

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A harness that captured within this window is not unusually quiet. */
export const HARNESS_SILENT_MS = DAY_MS;
/** Machine activity must be recent enough to distinguish a quiet harness from an idle machine. */
export const MACHINE_ACTIVE_MS = HOUR_MS;
/** Allow small clock differences between local harness use and Deployment receipt. */
export const HARNESS_RUN_CAPTURE_MARGIN_MS = 5 * 60_000;

export type HarnessAttentionFact =
  | { kind: 'harness_needs_repair'; machineId: string; machineName: string | null; harness: string; state: Exclude<ProvisionedHarnessFact['state'], 'ready'>; action: string; since: number }
  | { kind: 'harness_capture_silent'; machineId: string; machineName: string | null; harness: string; lastCapturedAt: number; lastMachineActivityAt: number };

/** Combine the member's current provisioned state with Deployment-owned capture and contact times. */
export async function provisionedHarnessAttention(db: RelationalStore, now: number): Promise<HarnessAttentionFact[]> {
  const [reports, sessions, machineSessions, contacts, claims] = await Promise.all([
    readProvisionedHarnessReports(db),
    latestHarnessCapture(db),
    recentMachineCapture(db, now - MACHINE_ACTIVE_MS),
    workerMachineActivity(db),
    claimedMachineNames(db),
  ]);
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
      if (harness.ranAt !== undefined) machineActivity.set(report.machineId, Math.max(machineActivity.get(report.machineId) ?? 0, harness.ranAt));
    }
  }
  const facts: HarnessAttentionFact[] = [];
  for (const report of reports) {
    for (const harness of report.harnesses) {
      const base = { machineId: report.machineId, machineName: machineNames.get(report.machineId) ?? null, harness: harness.id };
      const lastCapturedAt = captured.get(`${report.machineId}\0${harness.id}`) ?? null;
      const trustConfirmed = harness.state === 'trust_required' && (confirmedTrust.get(`${report.machineId}\0${harness.id}`) ?? 0) > harness.sinceAt;
      if (harness.state !== 'ready' && !trustConfirmed) {
        facts.push({ ...base, kind: 'harness_needs_repair', state: harness.state, action: harness.action!, since: harness.sinceAt });
        continue;
      }
      const lastMachineActivityAt = machineActivity.get(report.machineId) ?? null;
      if (harness.ranAt !== undefined && lastCapturedAt !== null && lastMachineActivityAt !== null
        && now - lastCapturedAt > HARNESS_SILENT_MS && now - lastMachineActivityAt <= MACHINE_ACTIVE_MS
        && harness.ranAt > lastCapturedAt + HARNESS_RUN_CAPTURE_MARGIN_MS) {
        facts.push({ ...base, kind: 'harness_capture_silent', lastCapturedAt, lastMachineActivityAt });
      }
    }
  }
  return facts;
}
