import { REPOSITORY_TASKS, REPOSITORY_CHECKOUT_CAPABILITY, type RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
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
 * The provider resolves task-first, then the Deployment default —
 * `agent.tasks.<task>.{provider,model}` before `agent.provider.*` — so a
 * per-task override in Settings routes that task alone. A credential travels
 * only into the launched runtime's environment, under the variable its harness
 * reads, and never into telemetry or an answer.
 */
import { DEPLOYMENT_WIDE_HOLDS, heldBy, readDispatchLimits, type DispatchLimits, type HeldBy } from './limits.js';
import type { ServerEnv } from './adapters.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken, revokeCredentialOfMember } from '../auth/tokens.js';
import { projectExists } from '../read/sessions.js';
import { WORKER_LEASE_MS } from '../constants.js';
import { emit } from '../telemetry.js';
import { claimQueuedRun, clearLease, lapsedLeases, nextClaimable, recordClaimedInput, recordQueueHolder, renewRunLease, requeueLapsedLease, type ClaimedRunRow } from './runs.js';
import { applyRunUpdate, ensureAgent, recordDispatch, dispatchLoad, failQueuedRun, hasSuccessorOf, INPUT_UNCHANGED, launchQueued, listQueuedAcrossProjects, recordQueued, getRun, hasLiveTaskRun, restoreDispatchCredential, returnToQueue, skipQueued, successorsSince, NO_LIMITS, type RunRow } from './runs.js';
import { openProviderCredential } from './provider-credentials.js';
import { leafValues } from './settings.js';
import { MAP_TASK } from '@goondocks/myco-shared/canopy';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { admissionForTask, runTimeoutForTask, UNLANDED_TASKS } from './task-catalogue.js';
import { runCloseRefusal } from './run-postconditions.js';
import { buildTaskInput, inputBuilderFor, instructionFor, instructionsFileFor, uninstructedError } from './task-inputs.js';

/** The member identity every dispatched runtime authenticates as; durable so attribution survives across runs. */
export const HARNESS_MEMBER_ID = 'mem_harness';
/** The agent identity a dispatched runtime claims under when its task names none; matches DEFAULT_AGENT_ID in the runner (packages/myco/src/constants.ts). */
export const HARNESS_AGENT_ID = 'myco-agent';
const HARNESS_MACHINE_ID = 'harness';
/** The shape a subscription sign-in credential carries; an API key starts `sk-ant-api…`. Each rides the variable its harness reads. */
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';
/** How long a run may take when its caller names no bound. */
export const DEFAULT_DISPATCH_TIMEOUT_SECONDS = 300;
/** How long a run may outlive its own bound before the Deployment treats its runtime as gone: the hosted hold releases the container at this margin, and the sweep fails the run at the same one. */
export const RUN_OVERRUN_MARGIN_MS = 120_000;
/** How much of a runtime's refusal rides the run row; the runtime bounds its own failures at the same length (`MAX_RUN_ERROR_CHARS` in packages/myco/src/agent/runtime/server-runner.ts). */
export const MAX_RUN_ERROR_CHARS = 2000;
/** What a run whose runtime would not start carries, before the refusal's own word. */
export const LAUNCH_REFUSED_ERROR = 'the runtime refused to start';
/** The admission a capture-driven task carries into its container, in place of a capability name. */
export const CAPTURE_DRIVEN_ADMISSION = 'captureDriven';

/**
 * The tasks the launch seam serves, which a worker cannot.
 *
 * Two of them declare no tool: their whole surface is a server-side step
 * loop over a run route — `/runs/embedding-step` and `/runs/canopy-map` —
 * rather than the MCP surface a worker's harness speaks. The third is the
 * containerized runtime's own end-to-end proof, so serving it anywhere else
 * would leave the path it exists to exercise untested.
 *
 * These three are why the seam survives, and all three retire with it.
 */
export const RUNTIME_SERVED_TASKS: readonly string[] = ['embedding-reconcile', MAP_TASK, 'container-smoke'];
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
  | 'no_provider' | 'no_credential' | 'no_endpoint' | 'unsupported_provider';

export const DISPATCH_REFUSAL_MESSAGE: Readonly<Record<DispatchRefusal, string>> = {
  repository_missing: 'Connect the project repository in Settings before running a code task.',
  harness_unavailable: 'this deployment has no harness runtime bound',
  unknown_task: 'the task is not one this deployment serves',
  no_instruction: 'the Deployment builds no instruction for this task, so a worker could not run it',
  not_landed: 'this task is not yet one a worker can drive; the Deployment queues no run of it',
  unknown_project: 'projectId names no Project this Deployment holds',
  no_provider: 'no provider is configured; Settings names one before a dispatch can run',
  no_credential: 'no anthropic credential is stored; Settings takes one before a dispatch can run',
  no_endpoint: 'openai-compatible needs agent.provider.base_url',
  unsupported_provider: 'the dispatcher serves anthropic and openai-compatible providers',
};

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
  | { ok: false; refusal: DispatchRefusal; /** The provider the refusal names, when one is configured but not served. */ providerType?: string };

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
  | { dispatched: false; refusal: DispatchRefusal; providerType?: string };

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
export async function dispatchPrepared(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, now: number, options: { singleFlight?: boolean } = {}): Promise<({ queued: false } & Launched) | ({ queued: true } & Queued)> {
  const limits = await readDispatchLimits(env);
  const held = await admitDispatch(env, prepared.task, now, limits);
  // Neither front door runs a harness. A worker-served task waits in the claim
  // queue whatever the load is, and a limit that holds it is still the holder
  // recorded on the run: a run past one is queued behind that limit rather than
  // behind a worker, which is what an operator reads on the run.
  if (prepared.servedBy === 'worker') return { queued: true, ...(await enqueueDispatch(env, prepared, spec, held ?? 'worker', now, options)) };
  if (held !== null) return { queued: true, ...(await enqueueDispatch(env, prepared, spec, held, now, options)) };
  try {
    return { queued: false, ...(await launchDispatch(env, prepared, spec, now, { limits, singleFlight: options.singleFlight })) };
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
export async function enqueueDispatch(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, held: HeldBy, now: number, options: { singleFlight?: boolean } = {}): Promise<Queued> {
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const runId = spec.runId ?? `run_${crypto.randomUUID()}`;
  const stored = storedSpecOf(spec);
  const scope = { projectId: prepared.projectId };
  if (!(await recordQueued(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, heldBy: held, queuedAt: now, dispatchSpec: JSON.stringify(stored), runContext: runContextOf(spec, spec.timeoutSeconds ?? runTimeoutForTask(prepared.task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS) }, options))) {
    if (options.singleFlight === true && (await getRun(env.db, scope, runId)) === null) throw new AlreadyRunning();
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
  outcome: { failed: string } | { skipped: string },
): Promise<boolean> {
  // Retiring the right credential requires the write's own answer: a drain that
  // relaunched and re-queued this row between the caller's read and this write
  // leaves the row naming one the caller never saw.
  const ended = 'failed' in outcome
    ? await failQueuedRun(env.db, scope, run.id, now, outcome.failed)
    : await skipQueued(env.db, scope, run.id, now, outcome.skipped);
  if (ended.applied) await retireDispatchCredential(env, ended.displaced, now);
  return ended.applied;
}

/**
 * Launch every queued run the limits now admit, oldest first. Each is prepared
 * again — a provider changed after it queued applies, and a refusal fails the
 * row by its own message — and admitted again against the load as it stands
 * after the launches before it. Answers how many launched.
 */
export async function drainQueue(env: ServerEnv, now: number): Promise<number> {
  let launched = 0;
  const limits = await readDispatchLimits(env);
  for (const queued of await listQueuedAcrossProjects(env.db, DRAIN_BATCH)) {
    const scope = { projectId: queued.projectId };
    if (queued.task === null || queued.dispatchSpec === null) {
      await endQueuedRun(env, scope, queued, now, { failed: NO_LAUNCH_ERROR });
      continue;
    }
    let stored: StoredSpec;
    try { stored = JSON.parse(queued.dispatchSpec) as StoredSpec; } catch {
      await endQueuedRun(env, scope, queued, now, { failed: NO_LAUNCH_ERROR });
      continue;
    }
    const prepared = await prepareDispatch(env, queued.task, queued.projectId);
    if (!prepared.ok) {
      if (prepared.refusal === 'harness_unavailable') return launched;
      await endQueuedRun(env, scope, queued, now, { failed: DISPATCH_REFUSAL_MESSAGE[prepared.refusal] });
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


const parseLeaf = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const str = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);
const record = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

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
    const admission = gate.kind === 'provider' ? CAPTURE_DRIVEN_ADMISSION : gate.kind === 'embedding' ? CAPTURE_DRIVEN_ADMISSION : gate.capability;
    return { ok: true, prepared: { task, projectId, servedBy: 'worker', providerType: null, model: null, provider: {}, credentialEnv: {}, admission } };
  }

  if (env.harnessLaunch === undefined) return { ok: false, refusal: 'harness_unavailable' };
  if (gate.kind === 'embedding') {
    const embedding = await env.embeddingProvider?.();
    if (env.vectors === undefined || embedding == null) return { ok: false, refusal: 'no_provider' };
    return { ok: true, prepared: { task, projectId, servedBy: 'runtime', providerType: 'embedding', model: embedding.modelKey, provider: {}, credentialEnv: {}, admission: CAPTURE_DRIVEN_ADMISSION } };
  }

  const byLeaf = await leafValues(env.db, ['agent.tasks', 'agent.provider.type', 'agent.provider.model', 'agent.model', 'agent.provider.base_url']);
  const override = record(record(parseLeaf(byLeaf.get('agent.tasks')))[task]);
  const providerType = str(override.provider) ?? str(parseLeaf(byLeaf.get('agent.provider.type')));
  if (providerType === null) return { ok: false, refusal: 'no_provider' };
  const model = str(override.model) ?? str(parseLeaf(byLeaf.get('agent.provider.model'))) ?? str(parseLeaf(byLeaf.get('agent.model')));
  const baseUrl = str(parseLeaf(byLeaf.get('agent.provider.base_url')));

  const credentialEnv: Record<string, string> = {};
  const provider: Record<string, unknown> = { type: providerType };
  if (model !== null) provider.model = model;
  if (providerType === 'anthropic') {
    const key = await openProviderCredential(env.db, env.wrappingKey, 'anthropic');
    if (key === null) return { ok: false, refusal: 'no_credential' };
    credentialEnv[key.startsWith(SUBSCRIPTION_TOKEN_PREFIX) ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
  } else if (providerType === 'openai-compatible') {
    if (baseUrl === null) return { ok: false, refusal: 'no_endpoint' };
    provider.baseUrl = baseUrl;
  } else {
    return { ok: false, refusal: 'unsupported_provider', providerType };
  }

  const admission = gate.kind === 'provider' ? CAPTURE_DRIVEN_ADMISSION : gate.capability;
  return { ok: true, prepared: { task, projectId, servedBy: 'runtime', providerType, model, provider, credentialEnv, admission } };
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
export async function launchDispatch(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, now: number, options: { limits?: DispatchLimits; singleFlight?: boolean } = {}): Promise<Launched> {
  if (env.harnessLaunch === undefined) throw new Error('harness runtime unbound after preparation');
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  await ensureMember(env.db, HARNESS_MEMBER_ID, now, 'member', 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, now);

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
  const admission = options.limits === undefined && options.singleFlight !== true ? undefined : { limits: options.limits ?? NO_LIMITS, now, singleFlight: options.singleFlight === true };
  // Nothing names this credential until the write lands, so a store that throws
  // anywhere between the mint and that write retires it on its way out.
  let carried: string | null;
  let recorded: boolean;
  try {
    carried = spec.fromQueue === true ? (await getRun(env.db, scope, runId))?.dispatchedBy ?? null : null;
    recorded = spec.fromQueue === true
      ? await launchQueued(env.db, scope, runId, { task: prepared.task, dispatchedBy: minted.tokenId, startedAt: now, runContext, instruction: spec.instruction ?? null, provider: prepared.providerType, model: prepared.model }, admission)
      : await recordDispatch(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, runContext, dispatchedBy: minted.tokenId, startedAt: now }, admission);
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
    await applyRunUpdate(env.db, scope, runId, { status: 'failed', completed_at: now, error: `${LAUNCH_REFUSED_ERROR}: ${message}`.slice(0, MAX_RUN_ERROR_CHARS) });
    throw new LaunchRefused(message, { cause: error });
  }
  return landed({ retire: carried });
}

/** Prepare and launch in one call, for a caller with no claim of its own to make between them. */
export async function dispatchTask(env: ServerEnv, task: string, projectId: string, spec: LaunchSpec, now: number): Promise<DispatchOutcome> {
  const prepared = await prepareDispatch(env, task, projectId);
  if (!prepared.ok) return { dispatched: false, refusal: prepared.refusal, ...(prepared.providerType === undefined ? {} : { providerType: prepared.providerType }) };
  return { dispatched: true, ...(await dispatchPrepared(env, prepared.prepared, spec, now)) };
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
    actor: replaced.actor,
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

/** A harness a worker has, and whether it is logged in. A worker offers these; the Deployment chooses among them. */
export interface OfferedHarness {
  id: string;
  authenticated: boolean;
}

/** What a claim answers a worker: the run, the harness chosen for it, the credentials it runs under, and what the worker lays out in the run's directory. */
export interface ClaimedRun extends ClaimedRunRow {
  repository?: RepositoryCheckoutSpec;
  harness: string;
  runToken: string;
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
 * Which harness runs this task: the Deployment's preference and fallback order,
 * intersected with what the worker actually has logged in. A per-task override
 * is read out of the `agent.tasks` document, the same way a provider override
 * is; there is no dotted-path leaf for it.
 *
 * A Deployment that names nothing takes whatever the worker offers. Settings
 * narrow the choice; their absence is not a refusal, so a machine with a
 * logged-in harness runs work the moment it attaches and an operator configures
 * a preference only to override that.
 *
 * Ids are matched against what the worker offers, never against a list this
 * server keeps. A worker released later carries harnesses this server has never
 * heard of, and a Deployment names one and gets it. The same rule answers an id
 * nobody offers: it yields no run rather than a substitute, so an operator who
 * misspells a preference reads an unrun queue instead of work quietly sent to
 * another vendor on another vendor's key.
 */
export function chooseHarness(preferred: string | null, fallback: readonly string[], override: string | null, offered: readonly OfferedHarness[]): string | null {
  const ready = offered.filter((h) => h.authenticated).map((h) => h.id);
  const wanted = [override ?? preferred, ...fallback].filter((id): id is string => typeof id === 'string' && id.length > 0);
  if (wanted.length === 0) return ready[0] ?? null;
  for (const id of wanted) if (ready.includes(id)) return id;
  return null;
}

async function harnessPreference(env: ServerEnv, task: string): Promise<{ preferred: string | null; fallback: string[]; override: string | null }> {
  const byLeaf = await leafValues(env.db, ['worker.harness', 'worker.harness_fallback', 'agent.tasks']);
  const fallbackLeaf = parseLeaf(byLeaf.get('worker.harness_fallback'));
  return {
    preferred: str(parseLeaf(byLeaf.get('worker.harness'))),
    fallback: Array.isArray(fallbackLeaf) ? fallbackLeaf.filter((v): v is string => typeof v === 'string' && v.trim() !== '') : [],
    override: str(record(record(parseLeaf(byLeaf.get('agent.tasks')))[task]).harness),
  };
}

/**
 * The credential the chosen harness reads, or nothing.
 *
 * Nothing is the ordinary case on a laptop: the harness is logged in on the
 * host and the Deployment holds no key for it. A cloud worker has no such login,
 * and this is what the Deployment injects per run.
 */
async function harnessCredentialEnv(env: ServerEnv, harness: string): Promise<Record<string, string>> {
  const declared = HARNESS_CREDENTIALS[harness];
  if (declared === undefined) return {};
  // Only the chosen harness's own provider is opened. A claim answering every
  // key the Deployment holds would widen what one answer discloses to every
  // provider at once, for keys the run cannot use.
  if (declared.provider === 'google') return {};
  const key = await openProviderCredential(env.db, env.wrappingKey, declared.provider);
  if (key === null) return {};
  // One rule decides the Anthropic variable on both paths: a subscription token
  // and an API key are the same slot under different names, and the value says
  // which. A harness declaring one variable takes it.
  const variable = declared.variables.length === 1
    ? declared.variables[0]!
    : (key.startsWith(SUBSCRIPTION_TOKEN_PREFIX) ? declared.variables[0]! : declared.variables[1]!);
  return { [variable]: key };
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
  const excluded = worker.capabilities?.includes(REPOSITORY_CHECKOUT_CAPABILITY)
    ? RUNTIME_SERVED_TASKS : [...new Set([...RUNTIME_SERVED_TASKS, ...REPOSITORY_TASKS])];
  const candidate = await nextClaimable(env.db, excluded);
  if (candidate === null) return { claimed: false, reason: 'no_work' };

  const preference = await harnessPreference(env, candidate.task);
  const harness = chooseHarness(preference.preferred, preference.fallback, preference.override, worker.harnesses);
  if (harness === null) return { claimed: false, reason: 'no_harness' };

  // A task whose prompt the server builds has it built again here: the run
  // reads the vault as it stands at the instant a worker takes it, rather than
  // as it stood at the dispatch. A Project that has not moved past the artifact
  // it already holds is skipped where it waits, before anything is minted,
  // through the release every queued row goes terminal by.
  let stored: StoredSpec | null = null;
  try { stored = candidate.dispatchSpec === null ? null : JSON.parse(candidate.dispatchSpec) as StoredSpec; } catch { stored = null; }
  const scope = { projectId: candidate.projectId };
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
    await endQueuedRun(env, scope, { id: candidate.id }, worker.now, { failed: uninstructedError(candidate.task) });
    emit({ kind: 'task_skipped', task: candidate.task, projectId: candidate.projectId, skip: 'uninstructed' });
    // The next row is taken now; a worker told `no_work` sleeps a poll interval per such row.
    return claimNextRun(env, worker);
  }

  await ensureMember(env.db, HARNESS_MEMBER_ID, worker.now, 'member', 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: harness, model: null, enabled: true }, worker.now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, worker.now);

  // The claim carries the same admission the launch does, in the write. A run
  // held by a limit stays queued with that limit recorded on it, and two
  // workers deciding at once cannot both pass a limit of one.
  const limits = await readDispatchLimits(env);
  const row = await claimQueuedRun(env.db, candidate, {
    dispatchedBy: minted.tokenId, leasedBy: worker.tokenId, leaseExpiresAt: worker.now + WORKER_LEASE_MS, harness, now: worker.now,
  }, { limits, now: worker.now });
  if (row === null) {
    await retireDispatchCredential(env, minted.tokenId, worker.now);
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
      runToken: minted.token,
      credentialEnv: await harnessCredentialEnv(env, harness),
      leaseExpiresAt: worker.now + WORKER_LEASE_MS,
      timeoutSeconds: runTimeoutForTask(row.task) ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    },
  };
}

/** Extend a lease this worker still holds. `held: false` says the lease is gone, and the worker stops driving a run it no longer owns. */
export async function renewLease(env: ServerEnv, worker: { tokenId: string; now: number }, run: { projectId: string; runId: string }): Promise<{ held: boolean; expiresAt: number }> {
  const expiresAt = worker.now + WORKER_LEASE_MS;
  const held = await renewRunLease(env.db, { projectId: run.projectId }, run.runId, worker.tokenId, expiresAt, worker.now);
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
  worker: { tokenId: string; now: number },
  run: { projectId: string; runId: string; status: 'completed' | 'failed'; error?: string | null },
): Promise<{ ended: boolean; reason?: string; status?: 'completed' | 'failed' }> {
  const scope = { projectId: run.projectId };
  const row = await getRun(env.db, scope, run.runId);
  if (row === null) return { ended: false, reason: 'no run of that id' };
  if (row.dispatchedBy === null || row.status !== 'running') return { ended: false, reason: 'the run is not running' };
  if (!(await renewRunLease(env.db, scope, run.runId, worker.tokenId, worker.now + WORKER_LEASE_MS, worker.now))) {
    return { ended: false, reason: 'the lease is no longer held' };
  }
  const unmet = run.status === 'completed' ? await runCloseRefusal(env.db, scope, row) : null;
  const status = unmet === null ? run.status : 'failed';
  const error = unmet ?? (run.error === undefined || run.error === null ? null : run.error.slice(0, MAX_RUN_ERROR_CHARS));
  const changed = await applyRunUpdate(env.db, scope, run.runId, {
    status, completed_at: worker.now, ...(error === null ? {} : { error }),
  });
  if (changed === 0) return { ended: false, reason: 'the run had already ended' };
  // The lease goes with the run: a worker that has finished holds nothing, and
  // a lease left behind reports it busy until the lease would have lapsed.
  await clearLease(env.db, scope, run.runId);
  await retireDispatchCredential(env, row.dispatchedBy, worker.now);
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
  return requeued;
}
