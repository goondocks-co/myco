import { type RunErrorCode, LAUNCH_REFUSED_ERROR } from './reader-codes.js';
import { prepareWorkerEnd } from './worker-end.js';
import type { WorkerUsage, ExecutionIdentity } from '@goondocks/myco-shared/worker-usage';
import { REPOSITORY_TASKS, capabilitiesRequiredBy, type RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
import { repositoryIdentity } from './repositories.js';
/**
 * The one dispatcher: every agent task a Deployment runs goes through here,
 * whatever asked for it — an owner's dispatch control, a session's end, a
 * person asking for a summary.
 *
 * A dispatch is two steps so a caller may decide between them. `prepareDispatch`
 * answers whether this Deployment CAN run the task — a bound runtime, a Project
 * it holds, a provider and its credential — and writes nothing. `launchDispatch`
 * mints the run's credential and starts its container. A caller with its own
 * claim to make (titling stamps the session first) prepares, claims, then
 * launches, and a refusal decided in preparation never costs it the claim.
 *
 * Worker tasks resolve their harness, execution profile and login at claim.
 * The retained runtime probe reads archived provider preferences and a per-task
 * model pin. Credentials travel only in the runtime environment, never in
 * telemetry or answers.
 */
import { DEPLOYMENT_WIDE_HOLDS, heldBy, readDispatchLimits, type DispatchLimits, type HeldBy } from './limits.js';
import type { ServerEnv } from './adapters.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken, NO_RUNTIME_CLAIMS, revokeCredentialOfMember } from '../auth/tokens.js';
import { projectExists } from '../read/sessions.js';
import { HARNESS_MEMBER_ID, WORKER_LEASE_MS, MAX_RUN_ERROR_CHARS } from '../constants.js';
export { HARNESS_MEMBER_ID };
import { pruneUncaptured } from '../ingest/uncaptured.js';
import { pruneWorkerContacts, recentWorkerCapabilities, recentWorkerReports, WORKER_CONTACT_RETENTION_MS } from './worker-contacts.js';
import { catalogResolution, pruneModelCatalogs } from './model-catalogs.js';
import { CAPABILITY_HOLDS, credentialUnavailable, type CapabilityHold } from '@goondocks/myco-shared/run-holds';
import { emit } from '../telemetry.js';
import { claimQueuedRun, deploymentTaskEntriesSince, lapsedLeases, nextClaimable, recordClaimedInput, recordQueueHolder, recordTaskHolder, renewRunLease, requeueLapsedLease, UNATTRIBUTED_DISPATCH_ACTOR, type ActorCeiling, type ClaimedRunRow } from './runs.js';
export type { ActorCeiling } from './runs.js';
import { applyRunUpdate, ensureAgent, getDispatchActor, recordDispatch, dispatchLoad, failQueuedRun, hasSuccessorOf, INPUT_UNCHANGED, launchQueued, listQueuedAcrossProjects, recordQueued, getRun, hasLiveTaskRun, restoreDispatchCredential, returnToQueue, skipQueued, successorsSince, NO_LIMITS, type RunRow } from './runs.js';
import { openHarnessCredential, openProviderCredential } from './provider-credentials.js';
import { runtimeProbePreferences } from './runtime-probe.js';
import { embeddingWorkPlan } from './embedding/switch.js';
import { credentialEnvFor, providerCredentialEnv } from '@goondocks/myco-shared/harness-providers';
import type { ExecutionProfile, ProfileRefusal } from '@goondocks/myco-shared/execution-profile';
import { taskTierRefusal } from './execution-profile.js';
import {
  capabilityOf, capabilityOn, CLAIM_SETTING_LEAVES, chooseHarness, claimSettings, DEFAULT_DISPATCH_TIMEOUT_SECONDS, fleetSelection, harnessPreference, RUNTIME_SERVED_TASKS, selectExecution, workerPreference,
  type FleetReport, type LoginStep, type OfferedHarness,
} from './worker-selection.js';

export {
  capabilityOf, capabilityOn, CLAIM_SETTING_LEAVES, chooseHarness, claimSettings, DEFAULT_DISPATCH_TIMEOUT_SECONDS, harnessPreference, RUNTIME_SERVED_TASKS, workerPreference,
  type FleetReport, type OfferedHarness,
};
import { admissionForTask, OUTCOME_TASKS, runTimeoutForTask, UNLANDED_TASKS } from './task-catalogue.js';
import { buildTaskInput, inputBuilderFor, instructionFor, instructionsFileFor, uninstructedError } from './task-inputs.js';

/** The agent identity a dispatched runtime claims under when its task names none; matches DEFAULT_AGENT_ID in the runner (packages/myco/src/constants.ts). */
export const HARNESS_AGENT_ID = 'myco-agent';
const HARNESS_MACHINE_ID = 'harness';
/** How long a run may outlive its own bound before the Deployment treats its runtime as gone: the hosted hold releases the container at this margin, and the sweep fails the run at the same one. */
export const RUN_OVERRUN_MARGIN_MS = 120_000;
export { MAX_RUN_ERROR_CHARS } from '../constants.js';
/** What a run whose runtime would not start carries, before the refusal's own word. */
export { LAUNCH_REFUSED_ERROR } from './reader-codes.js';
/** The admission a capture-driven task carries into its container, in place of a capability name. */
export const CAPTURE_DRIVEN_ADMISSION = 'captureDriven';

/** How many runs of one task a Project may have re-queued in a day in place of runs the platform replaced. */
export const REPLACED_REQUEUES_PER_DAY = 2;
/** The window the per-day caps are counted over. */
const DAY_MS = 86_400_000;
/** The keys of a run's context the dispatcher writes itself; a re-queue rebuilds them rather than carrying them. */
const DISPATCHER_CONTEXT_KEYS = new Set(['timeoutSeconds', 'input_hash', 'counts', 'fresh', 'replaced', 'replaces']);

/**
 * Why a dispatch is refused before anything is launched. Each is a settled
 * answer an operator clears in Settings, or a capability this Deployment lacks;
 * none clears by retrying.
 */
export type DispatchRefusal =
  | 'harness_unavailable' | 'unknown_task' | 'unknown_project' | 'repository_missing' | 'no_instruction' | 'not_landed'
  | 'no_provider' | 'capability_off' | 'probe_preferences_invalid';

export const DISPATCH_REFUSAL_MESSAGE: Readonly<Record<DispatchRefusal, string>> = {
  repository_missing: 'Connect the project repository in Settings before running a code task.',
  harness_unavailable: 'this server cannot start tasks itself',
  unknown_task: 'this server cannot run that task',
  no_instruction: 'this server has no instructions for that task',
  not_landed: 'no machine can run that task yet',
  unknown_project: 'the project is not on this server',
  probe_preferences_invalid: 'The retained container check cannot use its stored preferences or key.',
  no_provider: 'search embeddings are unavailable; configure an embedding provider',
  capability_off: 'this task is turned off for the project; its capability is turned on in the project\'s Settings',
};

/** Why a queued run is skipped rather than handed to a worker when its Project has turned its task's capability off. */
export const CAPABILITY_OFF = 'capability_off';

/** A dispatch this Deployment can run: everything the launch needs, resolved and nothing yet written. */
export interface PreparedDispatch {
  task: string;
  projectId: string;
  /**
   * Who runs this task: a worker that claims it from the queue, or the launch
   * seam. Two tasks have no MCP tool surface at all — their whole surface is a
   * server-side step loop over a run route — so a worker whose only channel is
   * MCP cannot serve them. They keep the seam until it retires with them.
   */
  servedBy: 'worker' | 'runtime';
  /** Null for a worker-served task: which harness runs it, and under which credential, is resolved at the claim. */
  providerType: string | null;
  model: string | null;
  /** The provider block the runtime reads as `MYCO_PROVIDER_JSON`. */
  provider: Record<string, unknown>;
  /** The credential under the variable its harness reads; empty for a provider reached without one. */
  credentialEnv: Record<string, string>;
  /** What the runtime's claim carries: a capability name, or the capture-driven marker. */
  admission: string;
}

export type PrepareOutcome =
  | { ok: true; prepared: PreparedDispatch }
  | { ok: false; refusal: DispatchRefusal; /** The provider the refusal names, when one is configured but not served. */ providerType?: string; /** The capability a `capability_off` refusal names. */ capability?: string };

/** What a launch is told beyond the prepared dispatch: where to call back, who asked, how long, and the task's parameters. */
export interface LaunchSpec {
  /** The origin the runtime calls back to — the request's own, so one Deployment never sends its runtime to another. */
  serverUrl: string;
  /** The member the dispatch is attributed to. */
  actor: string;
  timeoutSeconds?: number;
  /** Task parameters, handed to the runtime as `MYCO_TASK_PARAMS` and recorded on the run as its context. */
  params?: Record<string, string>;
  /** The run id to launch under; minted here when absent. */
  runId?: string;
  /** The run is a queued row the drain is launching: it moves from `queued` rather than being recorded afresh. */
  fromQueue?: boolean;
  /** The prompt the server built for this run, written on the run row and read back over `/runs/instruction`. */
  instruction?: string;
  /** The hash of the material behind `instruction`, recorded in the run's context so the write route reads it from the run rather than from the caller. */
  inputHash?: string;
  /** What the material behind the input counted, recorded beside the hash. */
  counts?: Readonly<Record<string, number | boolean>>;
  /** How this run differs from an ordinary one. */
  options?: DispatchOptions;
  /** The run this one stands in for, recorded in its context, when the platform replaced that run mid-flight. */
  replaces?: string;
}

/** What a caller asks of one dispatch beyond the task and its parameters. */
export interface DispatchOptions {
  /** The run does its work and writes nothing; its write routes answer `written: false`. */
  dryRun?: boolean;
  /** The run writes its artifact from the material alone rather than carrying the current one forward. */
  fresh?: boolean;
}

export interface Launched {
  runId: string;
  task: string;
  projectId: string;
  timeoutSeconds: number;
  provider: string;
}

/** A dispatch the Deployment holds back: the run row waits in the queue under the limit that holds it. */
export interface Queued {
  runId: string;
  task: string;
  projectId: string;
  heldBy: HeldBy;
}

export type DispatchOutcome =
  | ({ dispatched: true; queued: false } & Launched)
  | ({ dispatched: true; queued: true } & Queued)
  | { dispatched: false; refusal: DispatchRefusal; providerType?: string; capability?: string };

/** What the queue keeps of a launch spec until the drain launches it. The instruction is not kept: a task that carries one has it rebuilt at launch. */
interface StoredSpec {
  serverUrl: string;
  actor: string;
  timeoutSeconds: number;
  params?: Record<string, string>;
  options?: DispatchOptions;
  replaces?: string;
}

/** What the queue keeps of a dispatch, from the launch spec it carries. */
/**
 * The context a run carries on its row: the task's parameters, the bound it
 * runs under, and what the server decided at dispatch — the input hash it
 * filed the ask under, the counts behind it, an owner's from-scratch ask, and
 * the run this one stands in for.
 *
 * One builder serves both ways a row is written. A run that waits for a worker
 * is written once and never launched, so a context built only at launch would
 * leave every reader of these fields — the titling material, the digest's
 * substrate hash, the run bound, the replaced-run cap — with nothing to read.
 */
function runContextOf(spec: LaunchSpec, timeoutSeconds: number): string {
  return JSON.stringify({
    ...(spec.params ?? {}),
    timeoutSeconds,
    ...(spec.inputHash === undefined ? {} : { input_hash: spec.inputHash }),
    ...(spec.counts === undefined ? {} : { counts: spec.counts }),
    ...(spec.options?.fresh === true ? { fresh: true } : {}),
    ...(spec.replaces === undefined ? {} : { replaces: spec.replaces }),
  });
}

function storedSpecOf(spec: LaunchSpec): StoredSpec {
  return {
    serverUrl: spec.serverUrl, actor: spec.actor, timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    ...(spec.params === undefined ? {} : { params: spec.params }),
    ...(spec.options === undefined ? {} : { options: spec.options }),
    ...(spec.replaces === undefined ? {} : { replaces: spec.replaces }),
  };
}

/** What a status write presenting a credential the run's row does not name is refused with. */
export const STALE_CREDENTIAL_REFUSAL = 'this run is dispatched under another credential';

/** How a queued row whose launch spec cannot be read is failed. */
export const NO_LAUNCH_ERROR = 'the queued dispatch carries no launch';

/** How many queued runs one drain considers; the next wake continues. */
export const DRAIN_BATCH = 200;

/** A launch the write refused on a limit: no row is written, the credential minted for it is revoked, and the dispatch belongs in the queue. */
export class LimitReached extends Error {
  constructor() { super('a limit holds this dispatch'); this.name = 'LimitReached'; }
}

/** A write past an actor's Deployment-wide ceiling: no row is written, and the dispatch is neither launched nor queued. */
export class CeilingReached extends Error {
  constructor() { super('the actor\'s ceiling holds this dispatch'); this.name = 'CeilingReached'; }
}

/** A single-flight task with another run of it live in the Project: the write refused, and the dispatch is skipped rather than queued. */
export class AlreadyRunning extends Error {
  constructor() { super('another run of this task is live'); this.name = 'AlreadyRunning'; }
}

/** A queued row the drain found no longer queued: another drain launched it, or it failed. */
export class NotQueued extends Error {
  constructor() { super('the run is not queued'); this.name = 'NotQueued'; }
}

/**
 * Why a runtime is not taking a run, when the answer is not the run's fault.
 *
 * `draining` is the shape of every deploy: the harness stops before the server
 * rolls, and it clears on its own. `unreachable` is a runtime that answered
 * nothing at all, which is a fault an operator has to see.
 */
export type RuntimeUnavailable = 'draining' | 'unreachable';

/**
 * The runtime is not taking runs at this instant. The run goes back to the
 * queue rather than failing, and the next drain launches it; `runId` names the
 * row once `launchDispatch` has returned it.
 */
/**
 * The runtime is already running the run this launch names.
 *
 * A launch answered after its bound is re-queued and offered again, and the
 * supervisor that started a child for it the first time refuses the second by
 * run id. The run is running: the row keeps the credential that child holds,
 * and the launch counts as landed.
 */
/**
 * The runtime refused a launch on terms that end the run, and the row carries
 * that refusal. A caller reading this knows the run is answered; a throw of any
 * other kind reaches it from before the row write.
 */
export class LaunchRefused extends Error {
  constructor(message: string, options: { cause: unknown }) { super(message, options); this.name = 'LaunchRefused'; }
}

export class RuntimeAlreadyHolding extends Error {
  constructor(message: string) { super(message); this.name = 'RuntimeAlreadyHolding'; }
}

export class RuntimeDraining extends Error {
  constructor(message: string, readonly why: RuntimeUnavailable = 'draining', readonly runId?: string) {
    super(message);
    this.name = 'RuntimeDraining';
  }
}

/**
 * Whether a prepared dispatch may launch now, or which limit holds it.
 * Reads the limits and the load fresh on every ask, so a limit changed in
 * Settings applies to the next dispatch and the next drain alike.
 */
export async function admitDispatch(env: ServerEnv, task: string, now: number, limits?: DispatchLimits, exclude?: string): Promise<HeldBy | null> {
  const [read, load] = await Promise.all([
    limits === undefined ? readDispatchLimits(env) : Promise.resolve(limits),
    // A row already in the table is admitted against the others; a fresh
    // dispatch has none to leave out.
    dispatchLoad(env.db, task, now, exclude),
  ]);
  return heldBy(load, read);
}

/**
 * Dispatch a prepared task: launch it now, or hold it in the queue under the
 * limit that holds it. The launch's own write carries the limit check, so a
 * dispatch that reads the load as free and then loses the race to another is
 * queued rather than launched past the limit.
 */
export async function dispatchPrepared(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, now: number, options: { singleFlight?: boolean; ceiling?: ActorCeiling } = {}): Promise<({ queued: false } & Launched) | ({ queued: true } & Queued)> {
  const limits = await readDispatchLimits(env);
  const held = await admitDispatch(env, prepared.task, now, limits);
  // Neither front door runs a harness. A worker-served task waits in the claim
  // queue whatever the load is, and a limit that holds it is still the holder
  // recorded on the run: a run past one is queued behind that limit rather than
  // behind a worker, which is what an operator reads on the run.
  if (prepared.servedBy === 'worker') return { queued: true, ...(await enqueueDispatch(env, prepared, spec, held ?? 'worker', now, options)) };
  if (held !== null) return { queued: true, ...(await enqueueDispatch(env, prepared, spec, held, now, options)) };
  try {
    return { queued: false, ...(await launchDispatch(env, prepared, spec, now, { limits, singleFlight: options.singleFlight, ceiling: options.ceiling })) };
  } catch (err) {
    // The launch already returned the row to the queue; the dispatch waits there rather than being written twice.
    if (err instanceof RuntimeDraining && err.runId !== undefined) {
      return { queued: true, runId: err.runId, task: prepared.task, projectId: prepared.projectId, heldBy: 'runtime' };
    }
    if (!(err instanceof LimitReached)) throw err;
    const holder = (await admitDispatch(env, prepared.task, now, limits)) ?? 'concurrent_runs';
    return { queued: true, ...(await enqueueDispatch(env, prepared, spec, holder, now, options)) };
  }
}

/**
 * Hold a dispatch in the queue: a run row in `queued`, carrying the launch
 * asked of it and the limit that holds it, with no credential until it
 * launches. Wakes the Deployment so the drain follows as capacity returns.
 */
export async function enqueueDispatch(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, held: HeldBy, now: number, options: { singleFlight?: boolean; ceiling?: ActorCeiling } = {}): Promise<Queued> {
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const runId = spec.runId ?? `run_${crypto.randomUUID()}`;
  const stored = storedSpecOf(spec);
  const scope = { projectId: prepared.projectId };
  if (!(await recordQueued(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, heldBy: held, queuedAt: now, dispatchSpec: JSON.stringify(stored), runContext: runContextOf(spec, spec.timeoutSeconds ?? runTimeoutForTask(prepared.task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS) }, options))) {
    if ((await getRun(env.db, scope, runId)) === null) {
      if (await ceilingHolds(env.db, options.ceiling)) throw new CeilingReached();
      if (options.singleFlight === true) throw new AlreadyRunning();
    }
    throw new Error('run id already taken');
  }
  emit({ kind: 'harness_queued', runId, task: prepared.task, projectId: prepared.projectId, actor: spec.actor, heldBy: held });
  try { await env.wake?.(); } catch { /* the clock's floor still wakes the Deployment */ }
  return { runId, task: prepared.task, projectId: prepared.projectId, heldBy: held };
}

/**
 * Retire a harness credential.
 *
 * A run's credential exists for that run alone, and the row is what says which
 * one that is. The rule this function exists to make true: a credential is
 * revoked at the moment the row stops naming it, and at no other moment — so
 * every write that changes what a row names retires what it named before, in
 * the same breath, through here.
 *
 * What the gate over this holds is the dispatcher's own paths: no other caller
 * in `src/` reaches `revokeCredentialOfMember` for a harness credential except
 * the release a terminal run goes through. An operator revoking a credential by
 * id, or revoking the harness member itself, still reaches `auth/tokens.ts`
 * directly — that is an operator ending a credential the row still names, and
 * the run it names is left to the stale sweep, which closes it by its bound
 * like any run whose runtime went away.
 */
async function retireDispatchCredential(env: ServerEnv, tokenId: string | null, now: number): Promise<void> {
  if (tokenId === null) return;
  await revokeCredentialOfMember(env.db, HARNESS_MEMBER_ID, tokenId, now);
}

/**
 * End a queued run, and release what it holds.
 *
 * A queued row can carry the credential of a launch that may have started a
 * child; ending the row is the last moment anything can retire it, and after
 * the retention pass deletes the row nothing names it at all. Every terminal
 * transition of a queued row goes through here, which is what makes that true
 * of all of them rather than of the ones somebody remembered. The transition
 * itself reports what the row named, so the retirement follows the write rather
 * than a read that may be older than it.
 */
export async function endQueuedRun(
  env: ServerEnv,
  scope: { projectId: string },
  run: { id: string },
  now: number,
  outcome: { failed: string; errorCode: RunErrorCode } | { skipped: string },
): Promise<boolean> {
  // Retiring the right credential requires the write's own answer: a drain that
  // relaunched and re-queued this row between the caller's read and this write
  // leaves the row naming one the caller never saw.
  const ended = 'failed' in outcome
    ? await failQueuedRun(env.db, scope, run.id, now, outcome.failed, outcome.errorCode)
    : await skipQueued(env.db, scope, run.id, now, outcome.skipped);
  if (ended.applied) await retireDispatchCredential(env, ended.displaced, now);
  return ended.applied;
}

/**
 * Launch queued runs oldest first, checking stored preferences and availability,
 * then admitting each against the live load after earlier launches. Unavailable
 * harnesses hold their rows; terminal refusals fail them. Answers how many launched.
 */
export async function drainQueue(env: ServerEnv, now: number): Promise<number> {
  let launched = 0;
  const limits = await readDispatchLimits(env);
  for (const queued of await listQueuedAcrossProjects(env.db, DRAIN_BATCH)) {
    const scope = { projectId: queued.projectId };
    if (queued.task === null || queued.dispatchSpec === null) {
      await endQueuedRun(env, scope, queued, now, { failed: NO_LAUNCH_ERROR, errorCode: 'task_start_failed' });
      continue;
    }
    let stored: StoredSpec;
    try { stored = JSON.parse(queued.dispatchSpec) as StoredSpec; } catch {
      await endQueuedRun(env, scope, queued, now, { failed: NO_LAUNCH_ERROR, errorCode: 'task_start_failed' });
      continue;
    }
    const prepared = await prepareDispatch(env, queued.task, queued.projectId);
    if (!prepared.ok) {
      if (prepared.refusal === 'harness_unavailable') return launched;
      await endQueuedRun(env, scope, queued, now, { failed: DISPATCH_REFUSAL_MESSAGE[prepared.refusal], errorCode: 'task_start_failed' });
      continue;
    }
    // A worker-served run is not the drain's to launch: it waits in the claim
    // queue until a worker takes it, and the drain passes over it rather than
    // stopping, so a runtime-served run behind it still launches.
    if (prepared.prepared.servedBy === 'worker') continue;
    const held = await admitDispatch(env, queued.task, now, limits, queued.id);
    if (held !== null) {
      // A Deployment-wide holder holds every later row too; a per-task holder holds only this task's.
      if (DEPLOYMENT_WIDE_HOLDS.has(held)) return launched;
      continue;
    }
    // A task whose prompt the server builds has it built again here: the run
    // launches with the vault as it stands at this instant, and a Project that
    // has not moved past the artifact it already holds costs nothing.
    const built = await buildTaskInput(env, queued.task, queued.projectId, now, { fresh: stored.options?.fresh === true, params: stored.params });
    if (built !== null && built.unchanged) {
      await endQueuedRun(env, scope, queued, now, { skipped: INPUT_UNCHANGED });
      emit({ kind: 'task_skipped', task: queued.task, projectId: queued.projectId, skip: INPUT_UNCHANGED });
      continue;
    }
    const rebuilt: Pick<LaunchSpec, 'instruction' | 'inputHash' | 'counts'> = built === null || built.unchanged
      ? {}
      : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
    try {
      await launchDispatch(env, prepared.prepared, { ...stored, ...rebuilt, runId: queued.id, fromQueue: true }, now, { limits });
      launched += 1;
    } catch (err) {
      // A runtime that is not taking runs takes none of the rows after this one either; this wake ends and the next retries.
      if (err instanceof RuntimeDraining) return launched;
      // Another drain took this row between the read and the write. It is that
      // drain's now; the rows after it are still this one's to try.
      if (err instanceof NotQueued) {
        emit({ kind: 'harness_drain_raced', runId: queued.id, task: queued.task, projectId: queued.projectId });
        continue;
      }
      // The write refused on a limit another launch reached first: the row stays queued for the next drain. A Deployment-wide holder holds every later row too.
      if (err instanceof LimitReached) {
        const holder = await admitDispatch(env, queued.task, now, limits, queued.id);
        if (holder !== null && DEPLOYMENT_WIDE_HOLDS.has(holder)) return launched;
        continue;
      }
      const detail = (err instanceof Error ? err.message : String(err)).slice(0, MAX_RUN_ERROR_CHARS);
      // The launch met terms that end the run: the row carries the refusal, and
      // the rows after it still get their turn.
      if (err instanceof LaunchRefused) {
        emit({ kind: 'harness_drain_refused', runId: queued.id, task: queued.task, projectId: queued.projectId, error: detail });
        continue;
      }
      // Anything else reaches this drain from before the row write: the row is
      // as the queue left it, and the next wake offers it again.
      emit({ kind: 'harness_drain_failed', runId: queued.id, task: queued.task, projectId: queued.projectId, error: detail });
    }
  }
  return launched;
}


const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

/** Whether the bound runtime accepts this task. */
export function hasTaskRuntime(env: ServerEnv, task: string): boolean {
  return env.harnessLaunch !== undefined && (env.harnessTasks === undefined || env.harnessTasks.includes(task));
}

/**
 * Whether this Deployment can run `task` for `projectId` now, and with what.
 * Reads settings and, for a credentialed provider, opens the credential; writes
 * nothing and launches nothing.
 */
export async function prepareDispatch(env: ServerEnv, task: string, projectId: string): Promise<PrepareOutcome> {
  const gate = admissionForTask(task);
  if (gate === null) return { ok: false, refusal: 'unknown_task' };
  if (!(await projectExists(env.db, projectId))) return { ok: false, refusal: 'unknown_project' };

  // Unavailable tasks are refused before repository and provider requirements.
  if (UNLANDED_TASKS.includes(task)) return { ok: false, refusal: 'not_landed' };
  if (REPOSITORY_TASKS.includes(task) && await repositoryIdentity(env.db, { projectId }) === null) {
    return { ok: false, refusal: 'repository_missing' };
  }

  // A worker-served task queues and stops here. Its harness, and the credential
  // that harness reads, are resolved at the claim, where the worker's own
  // detection is known; nothing about a provider can be decided from settings
  // alone. A dispatch is never refused for want of one. It is refused for want
  // of an instruction: a worker hands its harness what the claim answers, and a
  // task the Deployment builds no prompt for would queue a row no claim could
  // ever hand out.
  if (!RUNTIME_SERVED_TASKS.includes(task)) {
    if (inputBuilderFor(task) === null) return { ok: false, refusal: 'no_instruction' };
    // A task a capability gates is queued only where the Project has turned it on, whoever asks. A runtime-served
    // task carries its admission into its container (`MYCO_TASK_ADMISSION`), which refuses there.
    const capability = capabilityOf(task);
    if (capability !== null && !(await capabilityOn(env.db, projectId, capability))) return { ok: false, refusal: 'capability_off', capability };
    const admission = gate.kind === 'capture' ? CAPTURE_DRIVEN_ADMISSION : gate.kind === 'embedding' ? CAPTURE_DRIVEN_ADMISSION : gate.capability;
    return { ok: true, prepared: { task, projectId, servedBy: 'worker', providerType: null, model: null, provider: {}, credentialEnv: {}, admission } };
  }

  if (env.harnessLaunch === undefined) return { ok: false, refusal: 'harness_unavailable' };
  if (!hasTaskRuntime(env, task)) return { ok: false, refusal: 'not_landed' };
  if (gate.kind === 'embedding') {
    const embedding = await embeddingWorkPlan(env, Date.now());
    if (embedding === null) return { ok: false, refusal: 'no_provider' };
    return { ok: true, prepared: { task, projectId, servedBy: 'runtime', providerType: 'embedding', model: embedding.model, provider: {}, credentialEnv: {}, admission: CAPTURE_DRIVEN_ADMISSION } };
  }

  const archived = await runtimeProbePreferences(env.db, task);
  const { type: providerType, model, baseUrl } = archived;
  if (providerType === null) return { ok: false, refusal: 'probe_preferences_invalid' };
  const provider: Record<string, unknown> = { type: providerType, ...(model === null ? {} : { model }) };
  let credentialEnv: Record<string, string> = {};
  if (providerType === 'anthropic') {
    const key = await openProviderCredential(env.db, env.wrappingKey, 'anthropic');
    if (key === null) return { ok: false, refusal: 'probe_preferences_invalid' };
    credentialEnv = providerCredentialEnv(providerType, key);
  } else if (providerType === 'openai-compatible' && baseUrl !== null) {
    provider.baseUrl = baseUrl;
  } else return { ok: false, refusal: 'probe_preferences_invalid' };
  const admission = gate.kind === 'capture' ? CAPTURE_DRIVEN_ADMISSION : gate.capability;
  return { ok: true, prepared: { task, projectId, servedBy: 'runtime', providerType, model, provider, credentialEnv, admission } };
}

/** Whether an actor's ceiling is full, read after a write refused: the count the write compared against. */
async function ceilingHolds(db: ServerEnv['db'], ceiling: ActorCeiling | undefined): Promise<boolean> {
  return ceiling !== undefined && (await deploymentTaskEntriesSince(db, ceiling.task, ceiling.sinceMs, ceiling.actor)) >= ceiling.perDay;
}

/**
 * Launch a prepared dispatch: the runtime's member and agent rows, a credential
 * minted for this run alone, the run's row written `pending` with the
 * dispatch's parameters as its context, and the held container started with
 * the whole dispatch as its environment. The row is the server's record of
 * the dispatch — the runtime's claim moves it to `running` and changes none
 * of it. Rejects when the runtime refuses to start, after marking the row
 * failed; the caller decides what its own state does then.
 */
export async function launchDispatch(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, now: number, options: { limits?: DispatchLimits; singleFlight?: boolean; ceiling?: ActorCeiling } = {}): Promise<Launched> {
  if (!hasTaskRuntime(env, prepared.task) || env.harnessLaunch === undefined) throw new Error('harness runtime unbound after preparation');
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  await ensureMember(env.db, HARNESS_MEMBER_ID, now, 'member', 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, now, null, NO_RUNTIME_CLAIMS, { rotates: false });

  const runId = spec.runId ?? `run_${crypto.randomUUID()}`;
  // The run's bound rides its context with the task's parameters, so the sweep
  // that fails a run whose runtime went away reads the same bound the runtime
  // received. A parameter reader ignores the key it does not name.
  // The hash of the material the server built this run's prompt from rides the
  // context beside the bound, so the route that writes the run's artifact takes
  // it from the row rather than from the runtime's word.
  const runContext = runContextOf(spec, timeoutSeconds);
  const scope = { projectId: prepared.projectId };
  // A re-queued row carries the credential of the child an earlier launch may
  // have started; the launch below replaces it, and what becomes of it depends
  // on whether that child is still running.
  // A queued row moves to pending for this credential; any other id is recorded afresh. Either way the row exists before
  // the launch, and the write itself carries the limit check when limits are given.
  const admission = options.limits === undefined && options.singleFlight !== true && options.ceiling === undefined
    ? undefined
    : { limits: options.limits ?? NO_LIMITS, now, singleFlight: options.singleFlight === true, ...(options.ceiling === undefined ? {} : { ceiling: options.ceiling }) };
  // Nothing names this credential until the write lands, so a store that throws
  // anywhere between the mint and that write retires it on its way out.
  let carried: string | null;
  let recorded: boolean;
  try {
    carried = spec.fromQueue === true ? (await getRun(env.db, scope, runId))?.dispatchedBy ?? null : null;
    recorded = spec.fromQueue === true
      ? await launchQueued(env.db, scope, runId, { task: prepared.task, dispatchedBy: minted.tokenId, startedAt: now, runContext, instruction: spec.instruction ?? null, provider: prepared.providerType, model: prepared.model }, admission)
      : await recordDispatch(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, runContext, dispatchedBy: minted.tokenId, startedAt: now, dispatchSpec: JSON.stringify(storedSpecOf(spec)) }, admission);
  } catch (error) {
    await retireDispatchCredential(env, minted.tokenId, now);
    throw error;
  }
  if (!recorded) {
    // No row names this credential: the write above changed nothing, and the
    // caller learns whether a limit or the row's own state refused it.
    await retireDispatchCredential(env, minted.tokenId, now);
    const existing = await getRun(env.db, scope, runId);
    if (spec.fromQueue === true) {
      if (existing === null || existing.status !== 'queued') throw new NotQueued();
      throw new LimitReached();
    }
    if (existing !== null) throw new Error('run id already taken');
    if (await ceilingHolds(env.db, options.ceiling)) throw new CeilingReached();
    if (options.singleFlight === true && (await hasLiveTaskRun(env.db, scope, prepared.task))) throw new AlreadyRunning();
    throw new LimitReached();
  }
  /**
   * What a launch that reached a runtime answers.
   *
   * The row names `minted` from the write above; `carried` is what it named
   * before, and no attempt is coming back for it.
   */
  // Only a runtime-served dispatch reaches a launch, and one always names its
  // provider: a worker-served task returns from `dispatchPrepared` before here.
  const provider = prepared.providerType ?? 'unknown';
  const landed = async (options: { retire?: string | null } = {}): Promise<Launched> => {
    if (options.retire !== minted.tokenId) await retireDispatchCredential(env, options.retire ?? null, now);
    emit({ kind: 'harness_dispatch', runId, task: prepared.task, projectId: prepared.projectId, actor: spec.actor });
    try { await env.wake?.(); } catch { /* the clock's floor still wakes the Deployment */ }
    return { runId, task: prepared.task, projectId: prepared.projectId, timeoutSeconds, provider };
  };

  try {
    await env.harnessLaunch({
    runId,
    timeoutSeconds,
    envVars: {
      MYCO_SERVER_URL: spec.serverUrl,
      MYCO_MEMBER_TOKEN: minted.token,
      MYCO_PROJECT: prepared.projectId,
      MYCO_RUN_ID: runId,
      MYCO_TASK: prepared.task,
      MYCO_TASK_ADMISSION: prepared.admission,
      MYCO_TIMEOUT_SECONDS: String(timeoutSeconds),
      MYCO_PROVIDER_JSON: JSON.stringify(prepared.provider),
      ...(prepared.model === null ? {} : { MYCO_MODEL: prepared.model }),
      ...(runContext === null ? {} : { MYCO_TASK_PARAMS: runContext }),
      ...prepared.credentialEnv,
    },
  });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // The runtime is running this run already, under the credential it started
    // with: the row names that one again, and the one minted here named nothing.
    if (error instanceof RuntimeAlreadyHolding) {
      // The restore writes from `pending` alone. Where it landed the row names
      // `carried`; where it did not, the row has moved — a sweep, a terminal
      // write — and what it names now is what decides. Either way the row's own
      // credential is kept and the other retired.
      const restored = carried !== null && await restoreDispatchCredential(env.db, scope, runId, carried);
      const names = restored ? carried : (await getRun(env.db, scope, runId))?.dispatchedBy ?? null;
      for (const token of new Set([minted.tokenId, carried])) {
        if (token !== null && token !== names) await retireDispatchCredential(env, token, now);
      }
      return landed();
    }
    if (error instanceof RuntimeDraining) {
      // The row goes back to the queue naming the oldest credential still in
      // play: where a launch is answered late, that is the one its child holds.
      // `returnToQueue` writes from `pending` alone, so a row a claim has
      // already moved keeps what it holds and this branch does not apply.
      const keeps = carried ?? minted.tokenId;
      const returned = await returnToQueue(env.db, scope, runId, {
        heldBy: 'runtime', dispatchSpec: JSON.stringify(storedSpecOf(spec)), credential: keeps, now,
      });
      if (returned) {
        await retireDispatchCredential(env, keeps === minted.tokenId ? null : minted.tokenId, now);
        if (error.why === 'unreachable') {
          emit({ kind: 'harness_unreachable', runId, task: prepared.task, projectId: prepared.projectId, error: message });
        } else {
          emit({ kind: 'harness_draining', runId, task: prepared.task, projectId: prepared.projectId, error: message });
        }
        throw new RuntimeDraining(message, error.why, runId);
      }
      // The row moved on: the credential the launch just minted is the one its
      // child claims under, and the one an earlier attempt left is dead.
      return landed({ retire: carried });
    }
    // The run is over, so the row names neither of them any more.
    await retireDispatchCredential(env, minted.tokenId, now);
    await retireDispatchCredential(env, carried, now);
    await applyRunUpdate(env.db, scope, runId, { status: 'failed', completed_at: now, error: `${LAUNCH_REFUSED_ERROR}: ${message}`.slice(0, MAX_RUN_ERROR_CHARS) }, undefined, 'task_start_failed');
    throw new LaunchRefused(message, { cause: error });
  }
  return landed({ retire: carried });
}

/** Prepare and launch in one call, for a caller with no claim of its own to make between them. */
export async function dispatchTask(env: ServerEnv, task: string, projectId: string, spec: LaunchSpec, now: number, options: { ceiling?: ActorCeiling } = {}): Promise<DispatchOutcome> {
  const prepared = await prepareDispatch(env, task, projectId);
  if (!prepared.ok) return { dispatched: false, refusal: prepared.refusal, ...(prepared.providerType === undefined ? {} : { providerType: prepared.providerType }), ...(prepared.capability === undefined ? {} : { capability: prepared.capability }) };
  return { dispatched: true, ...(await dispatchPrepared(env, prepared.prepared, spec, now, options)) };
}

/** The run the platform replaced, with everything a fresh dispatch of it needs that the row does not carry. */
export interface ReplacedRun {
  run: RunRow;
  projectId: string;
  /** The origin the successor's runtime calls back to — the failing run's own request origin. */
  serverUrl: string;
  actor: string;
}

/** What became of the ask to run a replaced run again. */
export type RequeueOutcome =
  | { requeued: true; runId: string; queued: boolean }
  | { requeued: false; reason: 'no_task' | 'already_requeued' | 'daily_cap' | 'unchanged' | 'refused' };

/**
 * The parameters a re-queue carries forward: what the dispatch's caller named,
 * without the words the dispatcher writes for itself. A task whose prompt the
 * server builds has that prompt built afresh, so the hash and the counts the
 * old context carries belong to the run that ended.
 */
function carriedParams(runContext: string | null): Record<string, string> {
  if (runContext === null) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(runContext); } catch { return {}; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>)
      .filter(([key, value]) => !DISPATCHER_CONTEXT_KEYS.has(key) && typeof value === 'string')
      .map(([key, value]) => [key, value as string]),
  );
}

/** The run's context as a record, or an empty one where it holds none the reader can parse. */
function contextRecord(runContext: string | null): Record<string, unknown> {
  if (runContext === null) return {};
  try {
    const parsed: unknown = JSON.parse(runContext);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** One field of a run's context, read as the type the caller expects. */
function contextField<T>(runContext: string | null, key: string, ofType: (value: unknown) => T | undefined): T | undefined {
  if (runContext === null) return undefined;
  try {
    const parsed: unknown = JSON.parse(runContext);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return ofType((parsed as Record<string, unknown>)[key]);
  } catch {
    return undefined;
  }
}

/**
 * Run a replaced run again: one fresh dispatch of the same task for the same
 * Project, naming the run it stands in for.
 *
 * It goes through the dispatcher like any other ask, so the queue and the
 * limits apply. A task whose prompt the server builds has it built here, the
 * same build an owner's ask makes: a successor that launched at once with no
 * instruction and no hash would run on an empty prompt and its artifact write
 * would answer `written: false`. A Project standing where its artifact already
 * stands is left alone rather than run over unmoved material.
 *
 * Two caps hold the rest: a run already answered by a successor is never
 * answered twice, and a Project gets `REPLACED_REQUEUES_PER_DAY` of one task in
 * a day, so a Deployment rolling again and again does not turn one ask into a
 * stream of runs. The per-run cap and the per-task one are different bounds: a
 * drain that takes several un-claimed runs of one task away files a reclaim for
 * each, and they share that task's day between them — the first two are
 * answered and any beyond them are not.
 */
export async function requeueReplaced(env: ServerEnv, replaced: ReplacedRun, now: number): Promise<RequeueOutcome> {
  const { run, projectId } = replaced;
  if (run.task === null) return { requeued: false, reason: 'no_task' };
  const scope = { projectId };
  if (await hasSuccessorOf(env.db, scope, run.id)) return { requeued: false, reason: 'already_requeued' };
  if (await successorsSince(env.db, scope, run.task, now - DAY_MS) >= REPLACED_REQUEUES_PER_DAY) {
    return { requeued: false, reason: 'daily_cap' };
  }
  const timeoutSeconds = contextField(run.runContext, 'timeoutSeconds', (v) => (typeof v === 'number' && v > 0 ? v : undefined));
  const fresh = contextField(run.runContext, 'fresh', (v) => (v === true ? true : undefined));
  const built = await buildTaskInput(env, run.task, projectId, now, { fresh: fresh === true, params: contextRecord(run.runContext) });
  if (built !== null && built.unchanged) {
    emit({ kind: 'task_skipped', task: run.task, projectId, skip: INPUT_UNCHANGED });
    return { requeued: false, reason: 'unchanged' };
  }
  const input: Pick<LaunchSpec, 'instruction' | 'inputHash' | 'counts'> = built === null || built.unchanged
    ? {}
    : { instruction: built.input.instruction, inputHash: built.input.inputHash, counts: built.input.counts };
  const outcome = await dispatchTask(env, run.task, projectId, {
    serverUrl: replaced.serverUrl,
    actor: (await getDispatchActor(env.db, scope, run.id)) ?? UNATTRIBUTED_DISPATCH_ACTOR,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    params: carriedParams(run.runContext),
    ...input,
    options: { dryRun: run.dryRun === 1, ...(fresh === undefined ? {} : { fresh }) },
    replaces: run.id,
  }, now);
  if (!outcome.dispatched) return { requeued: false, reason: 'refused' };
  emit({ kind: 'harness_requeued', runId: outcome.runId, task: run.task, projectId, replaces: run.id, queued: outcome.queued });
  return { requeued: true, runId: outcome.runId, queued: outcome.queued };
}

// ---------------------------------------------------------------------------
// Worker mode: the claim queue, the lease, and what returns a run to it (#1151)
// ---------------------------------------------------------------------------

/** What a claim answers a worker: the run, the harness chosen for it, the credentials it runs under, and what the worker lays out in the run's directory. */
export interface ClaimedRun extends ClaimedRunRow {
  repository?: RepositoryCheckoutSpec;
  harness: string;
  profile: ExecutionProfile;
  runToken: string;
  attemptId: string;
  credentialEnv: Record<string, string>;
  leaseExpiresAt: number;
  timeoutSeconds: number;
  /** The standing rules the worker writes as the run's instructions file, or null for a task whose whole instruction is the prompt. */
  instructions: string | null;
}

export type ClaimOutcome =
  | { claimed: true; run: ClaimedRun }
  | { claimed: false; reason: 'no_work' | 'no_harness' | 'lost_race' | 'at_limit' };

/**
 * The key a chosen agent's run is handed: nothing for a worker's own sign-in,
 * else its one slot in this server's store, opened here and nowhere else, or
 * the holder when the slot holds nothing the agent can use.
 */
const claimLogin = (env: ServerEnv): LoginStep<Record<string, string>> => async (harness, plan) => {
  if (plan.kind === 'worker-login') return { login: {} };
  const key = await openHarnessCredential(env.db, env.wrappingKey, plan.slot);
  const credentialEnv = key === null ? {} : credentialEnvFor(harness, key);
  return Object.keys(credentialEnv).length === 0 ? { reason: credentialUnavailable(harness) } : { login: credentialEnv };
};

/**
 * Name on each queued repository run the worker capability it waits for, while no worker heard from lately
 * (`CONTACT_RECENT_MS`) reports what it needs, so the dashboard says why no worker takes it; and put back the
 * ordinary wait for a worker once one does. `unmet` is the repository tasks the asking worker cannot take. Only the
 * ordinary wait and a capability's are rewritten: a run a limit holds keeps its limit.
 *
 * The capability named is the fleet's gap, not the asking worker's: the first the task needs that no worker heard
 * from lately (the asker included) reports. Every worker asking in turn therefore names the same one, so the label
 * holds still between polls in a mixed fleet. A task whose every capability some worker reports waits for a worker:
 * a worker that writes digests also checks out, so one of them takes it.
 */
async function recordCapabilityHolds(env: ServerEnv, reported: readonly string[], unmet: readonly string[], now: number, settings: ReadonlyMap<string, string>): Promise<void> {
  const recent = unmet.length === 0 ? [] : [reported, ...await recentWorkerCapabilities(env.db, now)];
  const held = new Map<CapabilityHold, string[]>();
  const served: string[] = [];
  for (const task of REPOSITORY_TASKS) {
    if (OUTCOME_TASKS.includes(task) && taskTierRefusal(task, settings) !== null) continue;
    const required = capabilitiesRequiredBy(task);
    const takenBySomeone = !unmet.includes(task) || recent.some((capabilities) => required.every((c) => capabilities.includes(c)));
    const needed = CAPABILITY_HOLDS.filter((hold) => required.includes(hold));
    const missing = takenBySomeone ? undefined
      : needed.find((hold) => !recent.some((capabilities) => capabilities.includes(hold)));
    if (missing === undefined) served.push(task);
    else held.set(missing, [...(held.get(missing) ?? []), task]);
  }
  await recordTaskHolder(env.db, served, CAPABILITY_HOLDS, 'worker');
  for (const [hold, tasks] of held) await recordTaskHolder(env.db, tasks, ['worker', ...CAPABILITY_HOLDS.filter((other) => other !== hold)], hold, true);
}

type SelectedExecution = { harness: string; profile: ExecutionProfile; credentialEnv: Record<string, string> };

/** Resolve a task against one worker's offers in preference order, opening the chosen agent's login. */
export async function selectWorkerExecution(env: ServerEnv, task: string, offers: readonly OfferedHarness[], settings: ReadonlyMap<string, string>): Promise<{ selected: SelectedExecution | null; reason: string | null }> {
  const { selected, reason } = await selectExecution(env, task, offers, settings, claimLogin(env));
  return { selected: selected === null ? null : { harness: selected.harness, profile: selected.profile, credentialEnv: selected.login }, reason };
}

/** Keep profile holders based on the recent fleet's offers and current Settings. */
async function recordProfileHolds(env: ServerEnv, worker: { tokenId: string; harnesses: readonly OfferedHarness[]; capabilities?: readonly string[]; now: number }, settings: ReadonlyMap<string, string>): Promise<void> {
  const reports = (await recentWorkerReports(env.db, worker.now))
    .filter((report) => report.credentialId !== worker.tokenId)
    .map((report) => ({ offers: report.offers, capabilities: report.capabilities }));
  reports.push({ offers: [...worker.harnesses], capabilities: [...(worker.capabilities ?? [])] });
  for (const task of OUTCOME_TASKS) {
    const tierRefusal = taskTierRefusal(task, settings);
    if (tierRefusal !== null) {
      await recordTaskHolder(env.db, [task], ['worker', ...CAPABILITY_HOLDS], tierRefusal, true);
      continue;
    }
    const { holder } = await fleetExecution(env, task, reports, settings);
    await recordTaskHolder(env.db, [task], ['worker'], holder, true);
  }
}

/** What `reports` would run `task` under at a claim now, or the holder a queued run of it waits under (`fleetSelection`). */
export async function fleetExecution(env: ServerEnv, task: string, reports: readonly FleetReport[], settings: ReadonlyMap<string, string>): Promise<{ selected: SelectedExecution | null; holder: string }> {
  const { selected, holder } = await fleetSelection(env, task, reports, settings, claimLogin(env));
  return { selected: selected === null ? null : { harness: selected.harness, profile: selected.profile, credentialEnv: selected.login }, holder };
}

/**
 * Take the oldest queued run this worker can run.
 *
 * The queue is peeked before anything is minted, so an idle poll costs no
 * credential; a mint whose claim then loses the race is retired at once, through
 * the one function allowed to revoke a harness credential. The row reaches
 * `running` and names its credential in the same statement, so a claim never
 * answers a credential the MCP surface cannot yet resolve.
 */
export async function claimNextRun(
  env: ServerEnv,
  worker: { tokenId: string; machineId: string; harnesses: readonly OfferedHarness[]; capabilities?: readonly string[]; now: number },
): Promise<ClaimOutcome> {
  // A task is offered only to a worker that reports everything it needs.
  const reported = worker.capabilities ?? [];
  const unmet = REPOSITORY_TASKS.filter((task) => !capabilitiesRequiredBy(task).every((c) => reported.includes(c)));
  const settings = await claimSettings(env);
  await recordCapabilityHolds(env, reported, unmet, worker.now, settings);
  const excluded = [...RUNTIME_SERVED_TASKS, ...unmet];
  await recordProfileHolds(env, worker, settings);
  let candidate = await nextClaimable(env.db, excluded);
  let chosen: SelectedExecution | null = null;
  let held = false;
  while (candidate !== null) {
    const { selected } = await selectWorkerExecution(env, candidate.task, worker.harnesses, settings);
    chosen = selected;
    if (chosen !== null) break;
    held = true;
    excluded.push(candidate.task);
    candidate = await nextClaimable(env.db, excluded);
  }
  if (candidate === null || chosen === null) return { claimed: false, reason: held ? 'no_harness' : 'no_work' };
  const { harness, credentialEnv } = chosen;
  // What the claiming machine's harness listed the requested model as resolving to, so the run's model is judged against it.
  const resolvesTo = await catalogResolution(env.db, worker.machineId, harness, chosen.profile.model, worker.now);
  const profile = resolvesTo === undefined ? chosen.profile : { ...chosen.profile, resolvesTo };

  // A task whose prompt the server builds has it built again here: the run
  // reads the vault as it stands at the instant a worker takes it, rather than
  // as it stood at the dispatch. A Project that has not moved past the artifact
  // it already holds is skipped where it waits, before anything is minted,
  // through the release every queued row goes terminal by.
  let stored: StoredSpec | null = null;
  try { stored = candidate.dispatchSpec === null ? null : JSON.parse(candidate.dispatchSpec) as StoredSpec; } catch { stored = null; }
  const scope = { projectId: candidate.projectId };
  // A run of a task whose capability the Project turned off after it queued is skipped where it waits, naming why:
  // held, it would stand at the head of the queue for good. The claim's own write checks it again.
  const capability = capabilityOf(candidate.task);
  const skipOff = async (): Promise<ClaimOutcome> => {
    await endQueuedRun(env, scope, { id: candidate.id }, worker.now, { skipped: CAPABILITY_OFF });
    emit({ kind: 'task_skipped', task: candidate.task, projectId: candidate.projectId, skip: CAPABILITY_OFF });
    return claimNextRun(env, worker);
  };
  if (capability !== null && !(await capabilityOn(env.db, candidate.projectId, capability))) return skipOff();
  const built = await buildTaskInput(env, candidate.task, candidate.projectId, worker.now, { fresh: stored?.options?.fresh === true, params: stored?.params });
  if (built !== null && built.unchanged) {
    await endQueuedRun(env, scope, { id: candidate.id }, worker.now, { skipped: INPUT_UNCHANGED });
    emit({ kind: 'task_skipped', task: candidate.task, projectId: candidate.projectId, skip: INPUT_UNCHANGED });
    return { claimed: false, reason: 'no_work' };
  }
  // A run with nothing to say to its harness is ended here, before anything is
  // minted: handed out, it would end its turn having called nothing, and the
  // worker would report a run that did nothing as a run that finished.
  const instruction = instructionFor(built, candidate.instruction, inputBuilderFor(candidate.task) !== null);
  if (instruction === null) {
    await endQueuedRun(env, scope, { id: candidate.id }, worker.now, { failed: uninstructedError(candidate.task), errorCode: 'task_start_failed' });
    emit({ kind: 'task_skipped', task: candidate.task, projectId: candidate.projectId, skip: 'uninstructed' });
    // The next row is taken now; a worker told `no_work` sleeps a poll interval per such row.
    return claimNextRun(env, worker);
  }

  await ensureMember(env.db, HARNESS_MEMBER_ID, worker.now, 'member', 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: harness, model: null, enabled: true }, worker.now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, worker.now, null, NO_RUNTIME_CLAIMS, { rotates: false });

  // The claim carries the same admission the launch does, in the write. A run
  // held by a limit stays queued with that limit recorded on it, and two
  // workers deciding at once cannot both pass a limit of one.
  const limits = await readDispatchLimits(env);
  const row = await claimQueuedRun(env.db, candidate, {
    dispatchedBy: minted.tokenId, leasedBy: worker.tokenId, machineId: worker.machineId, leaseExpiresAt: worker.now + WORKER_LEASE_MS, harness, profile, now: worker.now,
  }, { limits, now: worker.now, ...(capability === null ? {} : { capability }) });
  if (row === null) {
    await retireDispatchCredential(env, minted.tokenId, worker.now);
    if (capability !== null && !(await capabilityOn(env.db, candidate.projectId, capability))) return skipOff();
    const held = await admitDispatch(env, candidate.task, worker.now, limits, candidate.id);
    if (held === null) return { claimed: false, reason: 'lost_race' };
    await recordQueueHolder(env.db, scope, candidate.id, held);
    return { claimed: false, reason: 'at_limit' };
  }
  if (built !== null && !built.unchanged) await recordClaimedInput(env.db, scope, row.id, minted.tokenId, built.input);

  emit({ kind: 'worker_claimed', runId: row.id, task: row.task, projectId: row.projectId, harness, tokenId: worker.tokenId });
  return {
    claimed: true,
    run: {
      ...row,
      instruction,
      instructions: instructionsFileFor(built),
      ...(built !== null && !built.unchanged && built.input.repository !== undefined ? { repository: built.input.repository } : {}),
      harness,
      profile,
      runToken: minted.token,
      attemptId: minted.tokenId,
      credentialEnv,
      leaseExpiresAt: worker.now + WORKER_LEASE_MS,
      timeoutSeconds: runTimeoutForTask(row.task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    },
  };
}

/** Extend a lease this worker still holds, on the attempt it names when it names one. `held: false` says the lease is gone, and the worker stops driving a run it no longer owns. */
export async function renewLease(env: ServerEnv, worker: { tokenId: string; now: number }, run: { projectId: string; runId: string; attemptId?: string }): Promise<{ held: boolean; expiresAt: number }> {
  const expiresAt = worker.now + WORKER_LEASE_MS;
  const held = await renewRunLease(env.db, { projectId: run.projectId }, run.runId, worker.tokenId, expiresAt, worker.now, run.attemptId);
  return { held, expiresAt };
}

/**
 * End a run the caller leases.
 *
 * The lease is what authorizes the write, not the dispatch credential: the
 * worker drives the run, the harness child holds the run credential, and only
 * one of them can say the run is over. The credential is retired as the row
 * stops naming it, through the one function that owns that rule.
 *
 * **The worker reports; the Deployment judges.** A worker sees a harness end
 * its turn, which is a fact about the harness rather than about the task: a
 * harness that never called the Deployment ends its turn the same way one that
 * did its work does. So a `completed` report is held to the task's own close
 * rule (`core/run-postconditions.ts`) against the evidence the store holds, and
 * a run that owes work it did not do is recorded `failed` with what it owed. The
 * report is still accepted either way — the lease ends and the credential is
 * retired — for a run that is over whatever it left behind; only the OUTCOME is
 * the Deployment's. The launch seam judges the same rule at `handleUpdateRun`,
 * so both front doors answer alike.
 */
export async function endLeasedRun(
  env: ServerEnv,
  worker: { tokenId: string; now: number; clock?: () => number },
  run: { projectId: string; runId: string; status: 'completed' | 'failed'; error?: string | null; usage?: WorkerUsage | null; identity?: ExecutionIdentity; accountingVersion?: number; attemptId?: string; refusal?: ProfileRefusal | null },
): Promise<{ ended: boolean; reason?: string; status?: 'completed' | 'failed' }> {
  const clock = worker.clock ?? (() => worker.now);
  const prepared = await prepareWorkerEnd(env, { tokenId: worker.tokenId, clock }, run);
  if ('held' in prepared) return { ended: false, reason: prepared.reason };
  const { row, unmet, status, update, errorCode, context } = prepared;
  const now = clock();
  const changed = await applyRunUpdate(env.db, { projectId: run.projectId }, run.runId, {
    ...update, completed_at: now,
  }, { tokenId: worker.tokenId, dispatchedBy: row.dispatchedBy, now }, errorCode, context);
  if (changed === 0) return { ended: false, reason: 'the lease is no longer held' };
  await retireDispatchCredential(env, row.dispatchedBy, now);
  if (unmet !== null) {
    emit({ kind: 'run_postcondition_unmet', runId: run.runId, projectId: run.projectId, task: row.task, reported: run.status, unmet, tokenId: worker.tokenId });
  }
  emit({ kind: 'worker_ended', runId: run.runId, projectId: run.projectId, status, tokenId: worker.tokenId });
  return { ended: true, status };
}

/**
 * Return every run whose lease has lapsed to the claim queue.
 *
 * A lapsed lease says the worker went away, which is a different fact from a
 * run outrunning its budget: this one is re-runnable and the stale sweep's is
 * not. So it requeues rather than fails, and the run keeps the place in the
 * queue it had already waited for.
 */
export async function expireLeases(env: ServerEnv, now: number): Promise<number> {
  let requeued = 0;
  for (const lapsed of await lapsedLeases(env.db, now, DRAIN_BATCH)) {
    if (!(await requeueLapsedLease(env.db, { projectId: lapsed.projectId }, lapsed.id, lapsed.leasedBy, now))) continue;
    await retireDispatchCredential(env, lapsed.dispatchedBy, now);
    requeued += 1;
    emit({ kind: 'worker_lease_expired', runId: lapsed.id, projectId: lapsed.projectId, tokenId: lapsed.leasedBy });
  }
  // The same sweep forgets a worker unheard from past the contact horizon,
  // bounded like the lease batch above. A worker holding a live lease keeps its
  // row whatever its age.
  await pruneWorkerContacts(env.db, now, WORKER_CONTACT_RETENTION_MS, DRAIN_BATCH);
  // And the model lists no machine has renewed within their freshness window, bounded the same way.
  await pruneModelCatalogs(env.db, now, DRAIN_BATCH);
  // And forgets a repository no machine has reported for a month, bounded the same way.
  await pruneUncaptured(env.db, now, DRAIN_BATCH);
  return requeued;
}
