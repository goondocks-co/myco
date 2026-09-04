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
import { heldBy, readDispatchLimits, type DispatchLimits, type HeldBy } from './limits.js';
import type { ServerEnv } from './adapters.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken, revokeCredentialOfMember } from '../auth/tokens.js';
import { projectExists } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import { applyRunUpdate, ensureAgent, recordDispatch, dispatchLoad, failQueuedRun, hasSuccessorOf, INPUT_UNCHANGED, launchQueued, listQueuedAcrossProjects, recordQueued, getRun, hasLiveTaskRun, skipQueued, successorsSince, NO_LIMITS, type RunRow } from './runs.js';
import { deploymentSecretStore } from './secrets.js';
import { leafValues } from './settings.js';
import { admissionForTask } from './task-catalogue.js';
import { buildTaskInput } from './task-inputs.js';

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
  | 'harness_unavailable' | 'unknown_task' | 'unknown_project'
  | 'no_provider' | 'no_credential' | 'no_endpoint' | 'unsupported_provider';

export const DISPATCH_REFUSAL_MESSAGE: Readonly<Record<DispatchRefusal, string>> = {
  harness_unavailable: 'this deployment has no harness runtime bound',
  unknown_task: 'the task is not one this deployment serves',
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
  providerType: string;
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
 * Whether a prepared dispatch may launch now, or which limit holds it.
 * Reads the limits and the load fresh on every ask, so a limit changed in
 * Settings applies to the next dispatch and the next drain alike.
 */
export async function admitDispatch(env: ServerEnv, task: string, now: number, limits?: DispatchLimits): Promise<HeldBy | null> {
  const [read, load] = await Promise.all([limits === undefined ? readDispatchLimits(env) : Promise.resolve(limits), dispatchLoad(env.db, task, now)]);
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
  if (held !== null) return { queued: true, ...(await enqueueDispatch(env, prepared, spec, held, now, options)) };
  try {
    return { queued: false, ...(await launchDispatch(env, prepared, spec, now, { limits, singleFlight: options.singleFlight })) };
  } catch (err) {
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
  const stored: StoredSpec = {
    serverUrl: spec.serverUrl, actor: spec.actor, timeoutSeconds: spec.timeoutSeconds ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS,
    ...(spec.params === undefined ? {} : { params: spec.params }),
    ...(spec.options === undefined ? {} : { options: spec.options }),
    ...(spec.replaces === undefined ? {} : { replaces: spec.replaces }),
  };
  const scope = { projectId: prepared.projectId };
  if (!(await recordQueued(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, heldBy: held, queuedAt: now, dispatchSpec: JSON.stringify(stored) }, options))) {
    if (options.singleFlight === true && (await getRun(env.db, scope, runId)) === null) throw new AlreadyRunning();
    throw new Error('run id already taken');
  }
  emit({ kind: 'harness_queued', runId, task: prepared.task, projectId: prepared.projectId, actor: spec.actor, heldBy: held });
  try { await env.wake?.(); } catch { /* the clock's floor still wakes the Deployment */ }
  return { runId, task: prepared.task, projectId: prepared.projectId, heldBy: held };
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
      await failQueuedRun(env.db, scope, queued.id, now, 'the queued dispatch carries no launch');
      continue;
    }
    let stored: StoredSpec;
    try { stored = JSON.parse(queued.dispatchSpec) as StoredSpec; } catch {
      await failQueuedRun(env.db, scope, queued.id, now, 'the queued dispatch carries no launch');
      continue;
    }
    const prepared = await prepareDispatch(env, queued.task, queued.projectId);
    if (!prepared.ok) {
      if (prepared.refusal === 'harness_unavailable') return launched;
      await failQueuedRun(env.db, scope, queued.id, now, DISPATCH_REFUSAL_MESSAGE[prepared.refusal]);
      continue;
    }
    const held = await admitDispatch(env, queued.task, now, limits);
    if (held !== null) {
      // A Deployment-wide holder holds every later row too; a per-task holder holds only this task's.
      if (held === 'fleet' || held === 'concurrent_runs') return launched;
      continue;
    }
    // A task whose prompt the server builds has it built again here: the run
    // launches with the vault as it stands at this instant, and a Project that
    // has not moved past the artifact it already holds costs nothing.
    const built = await buildTaskInput(env, queued.task, queued.projectId, now, { fresh: stored.options?.fresh === true });
    if (built !== null && built.unchanged) {
      await skipQueued(env.db, scope, queued.id, now, INPUT_UNCHANGED);
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
      // The write refused on a limit another launch reached first: the row stays queued for the next drain. A row no longer queued belongs to another drain; the next row still gets its turn.
      if (err instanceof LimitReached && (await admitDispatch(env, queued.task, now, limits)) !== null) {
        const holder = await admitDispatch(env, queued.task, now, limits);
        if (holder === 'fleet' || holder === 'concurrent_runs') return launched;
      }
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
  if (env.harnessLaunch === undefined) return { ok: false, refusal: 'harness_unavailable' };
  const gate = admissionForTask(task);
  if (gate === null) return { ok: false, refusal: 'unknown_task' };
  if (!(await projectExists(env.db, projectId))) return { ok: false, refusal: 'unknown_project' };

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
    const key = await deploymentSecretStore(env.db, env.wrappingKey).get('anthropic');
    if (key === null) return { ok: false, refusal: 'no_credential' };
    credentialEnv[key.startsWith(SUBSCRIPTION_TOKEN_PREFIX) ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
  } else if (providerType === 'openai-compatible') {
    if (baseUrl === null) return { ok: false, refusal: 'no_endpoint' };
    provider.baseUrl = baseUrl;
  } else {
    return { ok: false, refusal: 'unsupported_provider', providerType };
  }

  const admission = gate.kind === 'provider' ? CAPTURE_DRIVEN_ADMISSION : gate.capability;
  return { ok: true, prepared: { task, projectId, providerType, model, provider, credentialEnv, admission } };
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
  await ensureMember(env.db, HARNESS_MEMBER_ID, now, 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, now);

  const runId = spec.runId ?? `run_${crypto.randomUUID()}`;
  // The run's bound rides its context with the task's parameters, so the sweep
  // that fails a run whose runtime went away reads the same bound the runtime
  // received. A parameter reader ignores the key it does not name.
  // The hash of the material the server built this run's prompt from rides the
  // context beside the bound, so the route that writes the run's artifact takes
  // it from the row rather than from the runtime's word.
  const runContext = JSON.stringify({
    ...(spec.params ?? {}),
    timeoutSeconds,
    ...(spec.inputHash === undefined ? {} : { input_hash: spec.inputHash }),
    ...(spec.counts === undefined ? {} : { counts: spec.counts }),
    ...(spec.options?.fresh === true ? { fresh: true } : {}),
    ...(spec.replaces === undefined ? {} : { replaces: spec.replaces }),
  });
  const scope = { projectId: prepared.projectId };
  // A queued row moves to pending for this credential; any other id is recorded afresh. Either way the row exists before
  // the launch, and the write itself carries the limit check when limits are given. A write that changed nothing minted
  // a credential for no run: it is revoked here, and the caller learns whether a limit or the row's own state refused it.
  const admission = options.limits === undefined && options.singleFlight !== true ? undefined : { limits: options.limits ?? NO_LIMITS, now, singleFlight: options.singleFlight === true };
  const recorded = spec.fromQueue === true
    ? await launchQueued(env.db, scope, runId, { task: prepared.task, dispatchedBy: minted.tokenId, startedAt: now, runContext, instruction: spec.instruction ?? null, provider: prepared.providerType, model: prepared.model }, admission)
    : await recordDispatch(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, instruction: spec.instruction ?? null, dryRun: spec.options?.dryRun === true, provider: prepared.providerType, model: prepared.model, runContext, dispatchedBy: minted.tokenId, startedAt: now }, admission);
  if (!recorded) {
    await revokeCredentialOfMember(env.db, HARNESS_MEMBER_ID, minted.tokenId, now);
    const existing = await getRun(env.db, scope, runId);
    if (spec.fromQueue === true) {
      if (existing === null || existing.status !== 'queued') throw new NotQueued();
      throw new LimitReached();
    }
    if (existing !== null) throw new Error('run id already taken');
    if (options.singleFlight === true && (await hasLiveTaskRun(env.db, scope, prepared.task))) throw new AlreadyRunning();
    throw new LimitReached();
  }
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
    await applyRunUpdate(env.db, scope, runId, { status: 'failed', completed_at: now, error: 'the runtime refused to start' });
    throw error;
  }
  emit({ kind: 'harness_dispatch', runId, task: prepared.task, projectId: prepared.projectId, actor: spec.actor });
  try { await env.wake?.(); } catch { /* the clock's floor still wakes the Deployment */ }
  return { runId, task: prepared.task, projectId: prepared.projectId, timeoutSeconds, provider: prepared.providerType };
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
  | { requeued: false; reason: 'no_task' | 'already_requeued' | 'daily_cap' | 'refused' };

/**
 * The parameters a re-queue carries forward: what the dispatch's caller named,
 * without the words the dispatcher writes for itself. A task whose prompt the
 * server builds has it built again at launch, so the hash and the counts the
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
 * limits apply and a task whose prompt the server builds has it built at
 * launch against the vault as it then stands. Two caps hold it: a run already
 * answered by a successor is never answered twice, and a Project gets
 * `REPLACED_REQUEUES_PER_DAY` of one task in a day, so a Deployment rolling
 * again and again does not turn one ask into a stream of runs.
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
  const outcome = await dispatchTask(env, run.task, projectId, {
    serverUrl: replaced.serverUrl,
    actor: replaced.actor,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    params: carriedParams(run.runContext),
    options: { dryRun: run.dryRun === 1, ...(fresh === undefined ? {} : { fresh }) },
    replaces: run.id,
  }, now);
  if (!outcome.dispatched) return { requeued: false, reason: 'refused' };
  emit({ kind: 'harness_requeued', runId: outcome.runId, task: run.task, projectId, replaces: run.id, queued: outcome.queued });
  return { requeued: true, runId: outcome.runId, queued: outcome.queued };
}
