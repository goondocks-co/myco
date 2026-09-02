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
import type { ServerEnv } from './adapters.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken } from '../auth/tokens.js';
import { projectExists } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import { applyRunUpdate, ensureAgent, recordDispatch } from './runs.js';
import { deploymentSecretStore } from './secrets.js';
import { leafValues } from './settings.js';
import { admissionForTask } from './task-catalogue.js';

/** The member identity every dispatched runtime authenticates as; durable so attribution survives across runs. */
export const HARNESS_MEMBER_ID = 'mem_harness';
/** The agent identity a dispatched runtime claims under when its task names none; matches DEFAULT_AGENT_ID in the runner (packages/myco/src/constants.ts). */
const HARNESS_AGENT_ID = 'myco-agent';
const HARNESS_MACHINE_ID = 'harness';
/** The shape a subscription sign-in credential carries; an API key starts `sk-ant-api…`. Each rides the variable its harness reads. */
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';
/** How long a run may take when its caller names no bound. */
export const DEFAULT_DISPATCH_TIMEOUT_SECONDS = 300;
/** The admission a capture-driven task carries into its container, in place of a capability name. */
export const CAPTURE_DRIVEN_ADMISSION = 'captureDriven';

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
}

export interface Launched {
  runId: string;
  task: string;
  projectId: string;
  timeoutSeconds: number;
  provider: string;
}

export type DispatchOutcome =
  | ({ dispatched: true } & Launched)
  | { dispatched: false; refusal: DispatchRefusal; providerType?: string };

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
export async function launchDispatch(env: ServerEnv, prepared: PreparedDispatch, spec: LaunchSpec, now: number): Promise<Launched> {
  if (env.harnessLaunch === undefined) throw new Error('harness runtime unbound after preparation');
  const timeoutSeconds = spec.timeoutSeconds ?? DEFAULT_DISPATCH_TIMEOUT_SECONDS;
  await ensureMember(env.db, HARNESS_MEMBER_ID, now, 'harness runtime');
  await ensureAgent(env.db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: prepared.providerType, model: prepared.model, enabled: true }, now);
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, now);

  const runId = spec.runId ?? `run_${crypto.randomUUID()}`;
  const runContext = spec.params === undefined ? null : JSON.stringify(spec.params);
  const scope = { projectId: prepared.projectId };
  if (!(await recordDispatch(env.db, scope, { id: runId, agentId: HARNESS_AGENT_ID, task: prepared.task, provider: prepared.providerType, model: prepared.model, runContext, dispatchedBy: minted.tokenId, startedAt: now }))) {
    throw new Error('run id already taken');
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
  return { runId, task: prepared.task, projectId: prepared.projectId, timeoutSeconds, provider: prepared.providerType };
}

/** Prepare and launch in one call, for a caller with no claim of its own to make between them. */
export async function dispatchTask(env: ServerEnv, task: string, projectId: string, spec: LaunchSpec, now: number): Promise<DispatchOutcome> {
  const prepared = await prepareDispatch(env, task, projectId);
  if (!prepared.ok) return { dispatched: false, refusal: prepared.refusal, ...(prepared.providerType === undefined ? {} : { providerType: prepared.providerType }) };
  return { dispatched: true, ...(await launchDispatch(env, prepared.prepared, spec, now)) };
}
