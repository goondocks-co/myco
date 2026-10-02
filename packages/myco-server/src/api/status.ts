import type { CapabilityStatus, ServerEnv } from '../core/adapters.js';
import { pendingTranscripts, type TranscriptBacklog } from '../ingest/parse.js';
import type { CredentialContext, OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { emptyBodyRoute } from '../auth/members.js';
import { latestMeasurements, type MeasurementName, type StoreMeasurement } from '../core/store-maintenance.js';
import { storedBytes } from '../ingest/live-credential.js';
import { transcriptRetentionFact, type RetentionFact } from '../ingest/retention.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { workerLiveness } from '../core/runs.js';
import { CONTACT_RECENT_MS, readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { ok } from './scope.js';
import { captureRecency, type CaptureRow } from '../read/capture.js';
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
  // Infrastructure presence is answered before anything is trusted. A deployment whose
  // relational store is absent or unusable makes a query here throw, and the owner branch
  // answers a bare 503 naming nothing — on the one surface whose job is to name it. The
  // query is attempted and its failure absorbed, which reports the same way on every
  // target: a store that is missing, misconfigured, or unreachable all read as unusable
  // here rather than only the one shape a single platform happens to produce.
  const capabilities = deploymentCapabilities(env);
  // A surface whose advice differs by target reads the target here.
  const target = deploymentTarget(env);
  // `available: false` is the one field a surface reads before the numbers. A
  // store this handler could not question answers zero busy and zero queued,
  // and zero here means "not known", never "none attached".
  let workers: {
    available: boolean; workersBusy: number; runsQueued: number; recentWithinMs: number; fleet: WorkerFleetRow[];
  } = { available: false, workersBusy: 0, runsQueued: 0, recentWithinMs: CONTACT_RECENT_MS, fleet: [] };
  let found: number | null = null;
  let projects: Awaited<ReturnType<typeof listVisibleProjects>> = [];
  let transcriptBacklog: TranscriptBacklog | null = null;
  let own: Set<string> | null = null;
  try {
    found = await schemaVersion(env.db);
    // The same count the tick reads to decide how awake the Deployment stays.
    transcriptBacklog = await pendingTranscripts(env.db);
    // A member reads their own machines alone; `own` is null for an admin, who reads every one.
    own = isAdmin(ctx.member.role) ? null : await machinesOf(env.db, ctx.member.id);
    const counts = await workerLiveness(env.db, ctx.now);
    const fleet = await readWorkerFleet(env.db, ctx.now);
    workers = { available: true, ...counts, recentWithinMs: CONTACT_RECENT_MS, fleet: own === null ? fleet : fleet.filter((row) => row.machineId !== null && own!.has(row.machineId)) };
    projects = await listVisibleProjects(env.db, ctx.member, { includeArchived: true });
  } catch {
    return ok({ schema: schemaCheck(null), target, capabilities, workers, projects: [], capture: [], unavailable: ['capture'] });
  }
  // Read on its own, so a capture read that fails names itself in `unavailable` and leaves every other fact standing.
  let capture: CaptureRow[] = [];
  const unavailable: string[] = [];
  try {
    const recent = await captureRecency(env.db, ctx.now, ctx.member.id);
    capture = own === null ? recent : recent.filter((row) => own!.has(row.machineId));
  } catch {
    unavailable.push('capture');
  }
  return ok({
    schema: schemaCheck(found),
    target,
    capabilities,
    // What a capability list cannot answer: whether the queue is moving, and
    // which workers are attached. A capability is this server's own runtime
    // configuration; a worker attaches from elsewhere, and the two are reported
    // apart. `fleet` carries what each worker last reported about itself: every
    // worker to an admin, and those on a member's own machines to a member.
    workers,
    // Transcripts stored and not yet read into sessions: how many, and the bytes they have left.
    transcriptBacklog,
    projects: projects.map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount, archivedAt: p.archivedAt })),
    // When each machine's agents last sent anything, over the last `CAPTURE_WINDOW_MS`, most recent first: every
    // machine to an admin, and a member's own to a member. A machine is named to the member it belongs to alone, and
    // shown to anyone else as that member.
    capture,
    // The facts above that could not be read, so their absence says nothing.
    unavailable,
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
