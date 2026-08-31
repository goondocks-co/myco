/**
 * The harness runtime probe: the acceptance surface for a held runtime.
 *
 * An owner asks the Deployment to start a held runtime and exchange one
 * request with it. A target without one answers a refusal naming the
 * capability, which local dev and the parity harness treat as the expected
 * answer.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { ensureMember } from '../auth/enrollment.js';
import { issueMemberToken } from '../auth/tokens.js';
import { leafValues } from '../core/settings.js';
import { deploymentSecretStore } from '../core/secrets.js';
import { projectExists } from '../read/sessions.js';
import { emit } from '../telemetry.js';
import { badRequest, ok, readJsonObject } from './scope.js';

/** The member identity every dispatched runtime authenticates as; durable so attribution survives across runs. */
const HARNESS_MEMBER_ID = 'mem_harness';
const HARNESS_MACHINE_ID = 'harness';
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';
const PROJECT_ID_SHAPE = /^[A-Za-z0-9._-]{1,64}$/;

const parseLeaf = (value: string | undefined): unknown => {
  if (value === undefined) return undefined;
  try { return JSON.parse(value); } catch { return undefined; }
};
const leafStr = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/**
 * Dispatch one task to the harness runtime: resolve the Deployment's provider
 * and credential, mint the runtime's member credential, and launch the held
 * container with the whole dispatch as environment. This slice serves the
 * anthropic and openai-compatible provider shapes; general task routing is the
 * retained-task engine's.
 */
export async function handleHarnessDispatch(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.harnessLaunch === undefined) {
    return Response.json({ error: 'harness_unavailable', message: 'this deployment has no harness runtime bound' }, { status: 409 });
  }
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const task = typeof body.task === 'string' && body.task.length > 0 && body.task.length <= 128 ? body.task : null;
  const projectId = typeof body.projectId === 'string' && PROJECT_ID_SHAPE.test(body.projectId) ? body.projectId : null;
  if (task === null || projectId === null) return badRequest('dispatch requires task and projectId');
  if (!(await projectExists(env.db, projectId))) return badRequest('projectId names no Project this Deployment holds');
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 3600 ? body.timeoutSeconds : 300;

  const byLeaf = await leafValues(env.db, ['agent.provider.type', 'agent.provider.model', 'agent.model', 'agent.provider.base_url']);
  const providerType = leafStr(parseLeaf(byLeaf.get('agent.provider.type')));
  if (providerType === null) return badRequest('no provider is configured; Settings names one before a dispatch can run');
  const model = leafStr(parseLeaf(byLeaf.get('agent.provider.model'))) ?? leafStr(parseLeaf(byLeaf.get('agent.model')));
  const baseUrl = leafStr(parseLeaf(byLeaf.get('agent.provider.base_url')));

  const credentialEnv: Record<string, string> = {};
  const provider: Record<string, unknown> = { type: providerType };
  if (model !== null) provider.model = model;
  if (providerType === 'anthropic') {
    const key = await deploymentSecretStore(env.db, env.wrappingKey).get('anthropic');
    if (key === null) return badRequest('no anthropic credential is stored; Settings takes one before a dispatch can run');
    credentialEnv[key.startsWith(SUBSCRIPTION_TOKEN_PREFIX) ? 'CLAUDE_CODE_OAUTH_TOKEN' : 'ANTHROPIC_API_KEY'] = key;
  } else if (providerType === 'openai-compatible') {
    if (baseUrl === null) return badRequest('openai-compatible needs agent.provider.base_url');
    provider.baseUrl = baseUrl;
  } else {
    return badRequest(`dispatch serves anthropic and openai-compatible providers in this slice, and the configured provider is ${providerType}`);
  }

  await ensureMember(env.db, HARNESS_MEMBER_ID, ctx.now, 'harness runtime');
  const minted = await issueMemberToken(env.db, { memberId: HARNESS_MEMBER_ID, machineId: HARNESS_MACHINE_ID }, ctx.now);

  const runId = `run_${crypto.randomUUID()}`;
  await env.harnessLaunch({
    runId,
    timeoutSeconds,
    envVars: {
      MYCO_SERVER_URL: ctx.url.origin,
      MYCO_MEMBER_TOKEN: minted.token,
      MYCO_PROJECT: projectId,
      MYCO_RUN_ID: runId,
      MYCO_TASK: task,
      MYCO_TIMEOUT_SECONDS: String(timeoutSeconds),
      MYCO_PROVIDER_JSON: JSON.stringify(provider),
      ...(model === null ? {} : { MYCO_MODEL: model }),
      ...credentialEnv,
    },
  });
  emit({ kind: 'harness_dispatch', runId, task, projectId, actor: ctx.member.id });
  return ok({ runId, task, projectId, timeoutSeconds, provider: providerType });
}

export async function handleHarnessProbe(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.harnessProbe === undefined) {
    return Response.json({ error: 'harness_unavailable', message: 'this deployment has no harness runtime bound' }, { status: 409 });
  }
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 600 ? body.timeoutSeconds : 120;
  // One well-known runtime, reused: a fresh name per call would strand a warm
  // container per probe until its idle window ends, and the fleet is finite.
  const runId = 'probe';
  const answer = await env.harnessProbe(runId, timeoutSeconds);
  emit({ kind: 'harness_probe', runId, actor: ctx.member.id });
  return ok({ runId, timeoutSeconds, ...answer });
}
