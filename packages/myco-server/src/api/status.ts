import type { CapabilityStatus, ServerEnv } from '../core/adapters.js';
import { pendingTranscripts } from '../ingest/parse.js';
import type { CredentialContext, OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { emptyBodyRoute } from '../auth/members.js';
import { latestMeasurements, type MeasurementName, type StoreMeasurement } from '../core/store-maintenance.js';
import { storedBytes } from '../ingest/live-credential.js';
import { transcriptRetentionFact, type RetentionFact } from '../ingest/retention.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { workerLiveness } from '../core/runs.js';
import { CONTACT_RECENT_MS, readWorkerFleet } from '../core/worker-contacts.js';
import { ok } from './scope.js';
import { captureRecency } from '../read/capture.js';
import { machinesOf } from '../read/machines.js';
import { isAdmin } from '../auth/roles.js';

/**
 * What this Deployment can do, in the product's vocabulary.
 *
 * The operator name for a capability differs by target, so the capability is
 * what a surface states and the operator name is detail it can show alongside.
 * A
 * Deployment with no platform descriptor reports nothing rather than claiming
 * capability it cannot demonstrate.
 */
export function deploymentCapabilities(env: ServerEnv): CapabilityStatus[] {
  return env.platform?.capabilities() ?? [];
}

/** Which target this is, as it names itself; null when it names none. */
const deploymentTarget = (env: ServerEnv): string | null => env.platform?.name ?? null;

/** The schema this server expects beside the one its store holds; `found` is null when the store answered none. */
const schemaCheck = (found: number | null) => ({ expected: SERVER_SCHEMA_VERSION, found, matches: found === SERVER_SCHEMA_VERSION });

/** Those capabilities this environment cannot currently perform. */
export function absentCapabilities(env: ServerEnv): CapabilityStatus[] {
  return deploymentCapabilities(env).filter((c) => !c.present);
}

/**
 * Binding and schema sanity for the owner.
 *
 * The schema version is read on every member request, so a Worker bound to a wrong or
 * half-migrated database answers 401 or 503 to every member while a dashboard that only
 * reads its own routes looks perfectly healthy. This is the one surface where that
 * divergence is visible, which is why the parent spec assigns it to this plan.
 */
export async function handleStatus(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const capabilities = deploymentCapabilities(env);
  const target = deploymentTarget(env);
  const unavailable: string[] = [];
  const readFact = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); }
    catch { unavailable.push(name); return undefined; }
  };
  const own = isAdmin(ctx.member.role) ? null : await readFact('machines', () => machinesOf(env.db, ctx.member.id));
  const visibleMachines = <T extends { machineId: string | null }>(rows: T[]): T[] => {
    if (own === undefined) throw new Error('Machine ownership is unavailable');
    return own === null ? rows : rows.filter((row) => row.machineId !== null && own.has(row.machineId));
  };
  const [found, transcriptBacklog, projects, workerFacts, capture] = await Promise.all([
    readFact('schema', () => schemaVersion(env.db)),
    readFact('transcriptBacklog', () => pendingTranscripts(env.db)),
    readFact('projects', () => listVisibleProjects(env.db, ctx.member, { includeArchived: true })),
    readFact('workers', async () => {
      const [counts, fleet] = await Promise.all([workerLiveness(env.db, ctx.now), readWorkerFleet(env.db, ctx.now)]);
      return { available: true, ...counts, recentWithinMs: CONTACT_RECENT_MS, fleet: visibleMachines(fleet) };
    }),
    readFact('capture', async () => visibleMachines(await captureRecency(env.db, ctx.now, ctx.member.id))),
  ]);
  return ok({
    schema: schemaCheck(found ?? null), target, capabilities,
    workers: workerFacts ?? { available: false, workersBusy: 0, runsQueued: 0, recentWithinMs: CONTACT_RECENT_MS, fleet: [] },
    transcriptBacklog: transcriptBacklog ?? null,
    projects: (projects ?? []).map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount, archivedAt: p.archivedAt })),
    capture: capture ?? [], unavailable,
  });
}

/** A byte count this Deployment measured, or why it could not. */
export type ByteFact = { state: 'measured'; value: number; unit: 'bytes' } | { state: 'unavailable'; reason: string };

const bytes = (value: number): ByteFact => ({ state: 'measured', value, unit: 'bytes' });

/** The storage measurements every answer names, first and in this order, recorded or not. */
const STORAGE_NAMED: readonly MeasurementName[] = ['blob_bytes', 'size'];

/** A storage measurement, dated by the check that took it; `measuredAt` is null for one never taken. */
type StorageFact = StoreMeasurement & { measuredAt: number | null };

const unmeasured = (name: MeasurementName, reason: string): StorageFact => ({ name, state: 'unavailable', reason, measuredAt: null });

/** Blob bytes and the database size, then every other measurement store maintenance recorded, each as last recorded. */
async function storageFacts(env: ServerEnv): Promise<StorageFact[]> {
  if (env.storeMaintenance === undefined) return STORAGE_NAMED.map((name) => unmeasured(name, 'this target has no store maintenance to measure it'));
  const recorded = await latestMeasurements(env);
  return [
    ...STORAGE_NAMED.map((name) => recorded.find((m) => m.name === name) ?? unmeasured(name, 'not measured yet; store maintenance measures it when a check runs')),
    ...recorded.filter((m) => !STORAGE_NAMED.includes(m.name)),
  ];
}

export type { RetentionFact };

/**
 * `POST /members/status`: the Deployment's health as a member credential reads it, over a body that is the empty
 * object. Deployment-wide facts — the target, the schema check, the transcript retention window and the storage
 * measurements store maintenance last recorded — and the bytes the presented credential has stored, as information:
 * capture is never refused for volume. No Project is read or created, and nothing names another member, machine or
 * worker.
 */
export const handleMemberStatus = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const stored = await storedBytes(env.db, ctx.tokenId);
  return ok({
    persisted: true,
    target: deploymentTarget(env),
    schema: schemaCheck(await schemaVersion(env.db)),
    stored: stored === null ? { state: 'unavailable', reason: 'no saved access key matches this token' } satisfies ByteFact : bytes(stored),
    retention: { transcripts: await transcriptRetentionFact(env.db) },
    storage: await storageFacts(env),
  });
});
