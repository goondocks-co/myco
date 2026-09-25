import type { CapabilityStatus, ServerEnv } from '../core/adapters.js';
import type { CredentialContext, OwnerContext } from '../context.js';
import { MEMBER_TOKEN_BYTE_QUOTA, SERVER_SCHEMA_VERSION } from '../constants.js';
import { emptyBodyRoute } from '../auth/members.js';
import { latestMeasurements, type StoreMeasurement } from '../core/store-maintenance.js';
import { heldQuotaBytes } from '../ingest/quota.js';
import { recordedBlobBytes } from '../read/blobs.js';
import { schemaVersion } from '../read/meta.js';
import { listVisibleProjects } from './scope.js';
import { workerLiveness } from '../core/runs.js';
import { CONTACT_RECENT_MS, readWorkerFleet, type WorkerFleetRow } from '../core/worker-contacts.js';
import { ok } from './scope.js';

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
  try {
    found = await schemaVersion(env.db);
    const counts = await workerLiveness(env.db, ctx.now);
    workers = { available: true, ...counts, recentWithinMs: CONTACT_RECENT_MS, fleet: await readWorkerFleet(env.db, ctx.now) };
    projects = await listVisibleProjects(env.db, ctx.member, { includeArchived: true });
  } catch {
    return ok({ schema: schemaCheck(null), target, capabilities, workers, projects: [] });
  }
  return ok({
    schema: schemaCheck(found),
    target,
    capabilities,
    // What a capability list cannot answer: whether the queue is moving, and
    // which workers are attached. A capability is this server's own runtime
    // configuration; a worker attaches from elsewhere, and the two are reported
    // apart. `fleet` carries what each worker last reported about itself.
    workers,
    projects: projects.map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount, archivedAt: p.archivedAt })),
  });
}

/** A byte count this Deployment measured, or why it could not. */
export type ByteFact = { state: 'measured'; value: number; unit: 'bytes' } | { state: 'unavailable'; reason: string };

const bytes = (value: number): ByteFact => ({ state: 'measured', value, unit: 'bytes' });

/** The database measurements store maintenance last recorded, or the size named unavailable and why. */
async function databaseStorage(env: ServerEnv): Promise<{ measuredAt: number | null; measurements: StoreMeasurement[] }> {
  if (env.storeMaintenance === undefined) {
    return { measuredAt: null, measurements: [{ name: 'size', state: 'unavailable', reason: 'this target has no store maintenance to measure the database' }] };
  }
  const recorded = await latestMeasurements(env);
  return recorded ?? {
    measuredAt: null,
    measurements: [{ name: 'size', state: 'unavailable', reason: 'no store maintenance check has finished yet; the database is measured when one runs' }],
  };
}

/**
 * `POST /members/status`: the Deployment's health as a member credential reads it, over a body that is the empty
 * object. Deployment-wide facts — the target, the schema check, the bytes recorded blobs hold and the database
 * measurements store maintenance last recorded — and the presented credential's own byte quota. No Project is read
 * or created, and nothing names another member, machine or worker.
 */
export const handleMemberStatus = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const held = await heldQuotaBytes(env.db, { tokenId: ctx.tokenId, now: ctx.now });
  const used: ByteFact = held === null ? { state: 'unavailable', reason: 'no credential row carries this token' } : bytes(held);
  return ok({
    persisted: true,
    target: deploymentTarget(env),
    schema: schemaCheck(await schemaVersion(env.db)),
    quota: { used, limit: bytes(MEMBER_TOKEN_BYTE_QUOTA) },
    storage: { blobs: bytes(await recordedBlobBytes(env.db)), database: await databaseStorage(env) },
  });
});
