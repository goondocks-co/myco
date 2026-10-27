import { readBudgetStatus } from '../read/budget.js';
import { learningStatusLine, readLearningStatus } from '../core/learning-sessions.js';
import type { CapabilityStatus, ServerEnv } from '../core/adapters.js';
import { pendingTranscripts } from '../ingest/parse.js';
import type { CredentialContext, OwnerContext } from '../context.js';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { emptyBodyRoute } from '../auth/members.js';
import { latestMeasurements, type MeasurementName, type StoreMeasurement } from '../core/store-maintenance.js';
import { storedBytes } from '../ingest/live-credential.js';
import { transcriptRetentionFact, type RetentionFact } from '../ingest/retention.js';
import { schemaVersion, statusMetadata } from '../read/meta.js';
import { viewReadRefusalFinding } from '../core/attention-state.js';
import { listVisibleProjects } from './scope.js';
import { readFleetProjection } from '../read/fleet.js';
import { CONTACT_RECENT_MS } from '../core/worker-contacts.js';
import { ok } from './scope.js';
import { captureRecency } from '../read/capture.js';
import { machinesOf } from '../read/machines.js';
import { isAdmin } from '../auth/roles.js';
import { deploymentIdentity } from '../auth/authorization.js';
import { provisionedHarnessHealth } from '../core/harness-health.js';
import { readViewStatus } from '../read/view-status.js';
import { readViewCutover } from '../ingest/view-cutover.js';
import { readViewPreflightPage,decodeViewPreflightCursor,encodeViewPreflightCursor,type PreflightCursor } from '../core/view-preflight.js';
import { memberSubject,authorize } from '../auth/authorization.js';
import { badRequest,notFound,resolveProjectScope } from './scope.js';

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
  if(ctx.url.searchParams.has('viewPreflight')){
    const subject=await memberSubject(env.db,ctx.member.id,'http');
    if(!authorize(subject,'owner',{kind:'member',deploymentId:subject.deploymentId,exists:true}))return Response.json({error:'forbidden',reasonCode:'owner_required'},{status:403});
    const project=ctx.url.searchParams.get('project');if(!project)return badRequest('project is required');
    const scope=await resolveProjectScope(env.db,ctx.member,project);if(!scope)return notFound();
    let cursor:PreflightCursor;
    try{cursor=decodeViewPreflightCursor(scope.projectId,ctx.url.searchParams.get('cursor'));}
    catch{return badRequest('invalid preflight cursor');}
    const page=await readViewPreflightPage(env.db,scope.projectId,cursor);
    return ok({observedAt:ctx.now,preflight:{...page,nextCursor:page.nextCursor?encodeViewPreflightCursor(scope.projectId,page.nextCursor):null}});

  }
  const capabilities = deploymentCapabilities(env);
  const target = deploymentTarget(env);
  const unavailable: string[] = [];
  const readFact = async <T>(name: string, read: () => Promise<T>): Promise<T | undefined> => {
    try { return await read(); }
    catch { unavailable.push(name); return undefined; }
  };
  const ownedMachines = await readFact('machines', () => machinesOf(env.db, ctx.member.id));
  const own = isAdmin(ctx.member.role) ? null : ownedMachines;
  const visibleMachines = <T extends { machineId: string | null }>(rows: T[]): T[] => {
    if (own === undefined) throw new Error('Machine ownership is unavailable');
    return own === null ? rows : rows.filter((row) => row.machineId !== null && own.has(row.machineId));
  };
  const [metadata, transcriptBacklog, projects, workerFacts, capture, harnesses] = await Promise.all([
    readFact('schema', () => statusMetadata(env.db)),
    readFact('transcriptBacklog', () => pendingTranscripts(env.db)),
    readFact('projects', () => listVisibleProjects(env.db, ctx.member, { includeArchived: true })),
    readFact('workers', async () => {
      const projection = await readFleetProjection(env, ctx.now, isAdmin(ctx.member.role));
      return { available: true, workersBusy: projection.fleet.filter(row => row.busy !== null).length, runsQueued: projection.queue.count, recentWithinMs: CONTACT_RECENT_MS, ...projection, fleet: projection.fleet.filter(row => row.runner !== null || visibleMachines([row]).length > 0), legacyWorkers: visibleMachines(projection.legacyWorkers) };
    }),
    readFact('capture', async () => visibleMachines(await captureRecency(env.db, ctx.now, ctx.member.id))),
    readFact('installedAgents', async () => visibleMachines(await provisionedHarnessHealth(env.db)).map((fact) => {
      const { toolsDeployment, ...rest } = fact;
      return toolsDeployment !== undefined && ownedMachines?.has(fact.machineId) ? fact : rest;
    })),
  ]);
  const finding = metadata === undefined ? undefined : await readFact('view_state_inconsistent', async () => viewReadRefusalFinding(metadata.viewReadRefusal, ctx.now));
  const budget=await readFact('budget',()=>readBudgetStatus(env.db,ctx.now));
  const learning=await readFact('learning',async()=>{
    const status=await readLearningStatus(env.db);
    return {...status,line:learningStatusLine(status,budget??null,ctx.now)};
  });
  const views=await readFact('views',async()=>{
    if(projects===undefined)throw new Error('Project visibility unavailable');
    return readViewStatus(env.db,projects.map(project=>project.projectId),ctx.now);
  });
  const viewCutover=await readFact('viewCutover',()=>readViewCutover(env.db));
  return ok({
    budget,
    learning:learning??null,
    views:views??null,
    viewCutover:viewCutover??null,
    schema: schemaCheck(metadata?.version ?? null), target, capabilities,
    workers: workerFacts ?? { available: false, observedAt: ctx.now, workersBusy: null, runsQueued: null, recentWithinMs: CONTACT_RECENT_MS, fleet: null },
    transcriptBacklog: transcriptBacklog ?? null,
    projects: (projects ?? []).map((p) => ({ projectId: p.projectId, lastActivityAt: p.lastActivityAt, sessionCount: p.sessionCount, archivedAt: p.archivedAt })),
    capture: capture ?? [], harnesses: harnesses ?? [], unavailable,
    ...(finding == null ? {} : { findings: [finding] }),
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
    deploymentId: await deploymentIdentity(env.db),
    target: deploymentTarget(env),
    schema: schemaCheck(await schemaVersion(env.db)),
    stored: stored === null ? { state: 'unavailable', reason: 'no saved access key matches this token' } satisfies ByteFact : bytes(stored),
    retention: { transcripts: await transcriptRetentionFact(env.db) },
    storage: await storageFacts(env),
  });
});
