/**
 * What this Deployment can say about itself, as one document.
 *
 * Every fact comes from a producer that already serves a surface: the schema
 * read, the platform's capability list, the worker liveness counts, the fleet
 * read, the claim queue, the project list, the transcript backlog and the job
 * registry. Nothing here queries for itself, so a diagnostics document and the
 * Status page cannot disagree about the same fact.
 *
 * The document is a fixed field set, and it carries no free text: a store this
 * handler could not question is reported by a named state, never by the error it
 * raised, and a refusal is a term from a closed vocabulary rather than a
 * sentence. A message is a place a path, a key or a captured body can appear.
 */
import type { ServerEnv } from './adapters.js';
import { isKnownWorkerCapability } from '@goondocks/myco-shared/repository';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { SERVER_SCHEMA_VERSION } from '../constants.js';
import { schemaVersion } from '../read/meta.js';
import { listProjects } from '../read/sessions.js';
import { listQueuedAcrossProjects, workerLiveness } from './runs.js';
import { CONTACT_RECENT_MS, isContactOutcome, readWorkerFleet, type ContactOutcome, type WorkerFleetRow } from './worker-contacts.js';
import { pendingImportedTranscripts, pendingTranscriptBytes } from '../ingest/parse.js';
import { DEFERRED_JOBS, SERVER_JOBS, WAKE_CONTINUATIONS } from './jobs.js';
import { CLASSIFIERS } from '../telemetry.js';

export const DEPLOYMENT_BUNDLE_VERSION = 1;

/** How many queued runs one document lists, oldest first. */
export const MAX_QUEUED_REPORTED = 50;

/** What a Deployment document never carries, by class. */
export const DEPLOYMENT_OMISSIONS: readonly string[] = [
  'credentials — every stored provider key, and every member, run or grant token',
  'request bodies — the payload of any captured event and any stored blob',
  'authored text — prompts, responses, transcript contents and generated artifacts',
  'free-text detail — a failure is reported by a named state, never by its message',
] as const;

/** One capability this server is configured for. */
export interface CapabilityFacts {
  capability: string;
  present: boolean;
  operatorNames: string[];
}

/** A harness a worker reported, and whether it reported it logged in. Its own probe, never a tested provider. */
export interface ReportedHarnessFacts {
  id: string;
  authenticated: boolean;
}

/** One worker, by what the Deployment holds about it. */
export interface WorkerFacts {
  credentialId: string;
  machineId: string | null;
  /** Null when the stored report could not be read; empty is a worker reporting none. */
  offers: ReportedHarnessFacts[] | null;
  /** Offers outside the shared harness catalogue, counted without their supplied identifiers. */
  unknownOffers: number | null;
  capabilities: string[] | null;
  /** Capability names this Deployment does not know, counted rather than carried. */
  unknownCapabilities: number | null;
  /** Null for a row that records no reason, and for one whose stored reason is outside the vocabulary. */
  lastReason: ContactOutcome | null;
  /** Whether the stored reason was outside the vocabulary: null when none is recorded, else 0 or 1. */
  unknownReason: number | null;
  /** 0 for a lease holder with no recorded contact. */
  lastSeenAt: number;
  busy: { runId: string; projectId: string; task: string | null; leaseExpiresAt: number } | null;
  eligible: boolean;
  recent: boolean;
}

/** One queued run, by the facts that explain its wait. */
export interface QueuedRunFacts {
  runId: string;
  projectId: string;
  task: string | null;
  queuedAt: number;
  heldBy: string | null;
  /** Whether the row still names the credential of a launch, which is what keeps it out of the claim queue. */
  launched: boolean;
}

/** A project, by what it has received. */
export interface ProjectFacts {
  projectId: string;
  sessionCount: number;
  lastActivityAt: number | null;
  archivedAt: number | null;
}

/** One declared unit of recurring work, and whether this Deployment runs it. */
export interface DeclaredWorkFacts {
  name: string;
  kind: 'job' | 'deferred' | 'continuation';
  /** The deepest power state a job still runs at; null for a continuation, which no power state gates. */
  runsThrough: string | null;
  /** Who owns a job that is declared without an implementation. */
  owner: string | null;
}

/**
 * Whether the store could be questioned at all.
 *
 * `unavailable` is one named state for a store that is missing, misconfigured or
 * unreachable: telling the three apart would mean carrying the platform's
 * message.
 */
export type StoreState = 'readable' | 'unavailable';

export interface DeploymentDiagnostics {
  bundle: 'myco.deployment.diagnostics';
  bundleVersion: number;
  generatedAt: number;
  store: StoreState;
  schema: { expected: number; found: number | null; matches: boolean };
  capabilities: CapabilityFacts[];
  absentCapabilities: string[];
  /** Null when the store could not be questioned: zero workers would read as none attached. */
  workers: {
    workersBusy: number;
    runsQueued: number;
    recentWithinMs: number;
    fleet: WorkerFacts[];
  } | null;
  /** Null when the store could not be questioned. */
  queuedRuns: QueuedRunFacts[] | null;
  /** Null when the store could not be questioned. */
  projects: ProjectFacts[] | null;
  /** Null when the store could not be questioned. */
  ingestBacklog: { pendingTranscriptBytes: number; pendingImportedTranscripts: number } | null;
  /** Declared from the registry, so it is answered whether or not the store can be read. */
  declaredWork: DeclaredWorkFacts[];
  /** The closed vocabulary a refusal's code is drawn from, which is what joins this document to a member's refusal log. */
  refusalVocabulary: readonly string[];
  omissions: readonly string[];
}

/** Every declared unit of recurring work, from the one registry that owns their names. */
export function declaredWork(): DeclaredWorkFacts[] {
  return [
    ...SERVER_JOBS.map((job) => ({ name: job.name, kind: 'job' as const, runsThrough: job.runsThrough, owner: null })),
    ...DEFERRED_JOBS.map((job) => ({ name: job.name, kind: 'deferred' as const, runsThrough: job.runsThrough, owner: job.owner })),
    ...WAKE_CONTINUATIONS.map((c) => ({ name: c.name, kind: 'continuation' as const, runsThrough: null, owner: null })),
  ];
}

const workerFacts = (row: WorkerFleetRow): WorkerFacts => ({
  credentialId: row.credentialId,
  machineId: row.machineId,
  offers: row.offers === null ? null : row.offers.filter((offer) => Object.hasOwn(HARNESS_CREDENTIALS, offer.id)).map((offer) => ({ id: offer.id, authenticated: offer.authenticated })),
  unknownOffers: row.offers === null ? null : row.offers.filter((offer) => !Object.hasOwn(HARNESS_CREDENTIALS, offer.id)).length,
  capabilities: row.capabilities === null ? null : row.capabilities.filter(isKnownWorkerCapability),
  // A worker reports its own strings; only the ones this Deployment knows are carried, and the rest are counted so an absence is not read as none reported.
  unknownCapabilities: row.capabilities === null ? null : row.capabilities.filter((value) => !isKnownWorkerCapability(value)).length,
  lastReason: row.lastReason !== null && isContactOutcome(row.lastReason) ? row.lastReason : null,
  // A stored reason outside the vocabulary is counted, never carried.
  unknownReason: row.lastReason === null ? null : isContactOutcome(row.lastReason) ? 0 : 1,
  lastSeenAt: row.lastSeenAt,
  busy: row.busy === null ? null : { runId: row.busy.runId, projectId: row.busy.projectId, task: row.busy.task, leaseExpiresAt: row.busy.leaseExpiresAt },
  eligible: row.eligible,
  recent: row.recent,
});

function queuedFacts(row: { id: string; projectId: string; task: string | null; queuedAt: number; heldBy: string | null; dispatchedBy: string | null }): QueuedRunFacts {
  return { runId: row.id, projectId: row.projectId, task: row.task, queuedAt: row.queuedAt, heldBy: row.heldBy, launched: row.dispatchedBy !== null };
}

/**
 * The Deployment's own diagnostics.
 *
 * The capability list and the job registry are this server's configuration and
 * are answered before anything is read, so a Deployment whose store is unusable
 * still says what it is configured to do. Everything the store answers is read
 * inside one attempt: a failure leaves each of those fields null beside
 * `store: 'unavailable'`, which a reader distinguishes from a Deployment that
 * genuinely holds nothing.
 */
export async function deploymentDiagnostics(env: ServerEnv, now: number): Promise<DeploymentDiagnostics> {
  const capabilities: CapabilityFacts[] = (env.platform?.capabilities() ?? [])
    .map((c) => ({ capability: c.capability, present: c.present, operatorNames: [...c.operatorNames] }));
  const base = {
    bundle: 'myco.deployment.diagnostics' as const,
    bundleVersion: DEPLOYMENT_BUNDLE_VERSION,
    generatedAt: now,
    capabilities,
    absentCapabilities: capabilities.filter((c) => !c.present).map((c) => c.capability),
    declaredWork: declaredWork(),
    refusalVocabulary: CLASSIFIERS,
    omissions: DEPLOYMENT_OMISSIONS,
  };
  try {
    const found = await schemaVersion(env.db);
    const counts = await workerLiveness(env.db, now);
    const fleet = await readWorkerFleet(env.db, now);
    const queued = await listQueuedAcrossProjects(env.db, MAX_QUEUED_REPORTED);
    const projects = await listProjects(env.db, { includeArchived: true });
    return {
      ...base,
      store: 'readable',
      schema: { expected: SERVER_SCHEMA_VERSION, found, matches: found === SERVER_SCHEMA_VERSION },
      workers: { workersBusy: counts.workersBusy, runsQueued: counts.runsQueued, recentWithinMs: CONTACT_RECENT_MS, fleet: fleet.map(workerFacts) },
      queuedRuns: queued.map(queuedFacts),
      projects: projects.map((p) => ({ projectId: p.projectId, sessionCount: p.sessionCount, lastActivityAt: p.lastActivityAt, archivedAt: p.archivedAt })),
      ingestBacklog: {
        pendingTranscriptBytes: await pendingTranscriptBytes(env.db),
        pendingImportedTranscripts: await pendingImportedTranscripts(env.db),
      },
    };
  } catch {
    return {
      ...base,
      store: 'unavailable',
      schema: { expected: SERVER_SCHEMA_VERSION, found: null, matches: false },
      workers: null,
      queuedRuns: null,
      projects: null,
      ingestBacklog: null,
    };
  }
}
