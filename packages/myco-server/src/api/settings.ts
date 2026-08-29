import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';
import { deploymentSecretStore, type SecretDescription } from '../core/secrets.js';
import {
  DEPLOYMENT_LEAVES, PROJECT_CAPABILITIES, requiresStepUp, settingsWriter,
  type ProjectCapability, type SettingsRefusal,
} from '../core/settings.js';
import { spendStepUpAuthority, stepUpAuthorizer } from '../auth/step-up.js';
import { STEP_UP_HEADER } from '../constants.js';

/**
 * The Deployment Settings surface.
 *
 * Every write here goes through the one validated operation in `core/settings.ts`
 * rather than reaching the store itself — this module decides nothing about what
 * a setting means, only how it is asked for and answered.
 *
 * These are owner routes today, matching the one dashboard session the server
 * has. #915's model is that ALL members manage Deployment Settings; widening the
 * human surface from one owner to every member is #918's work, and the routes are
 * shaped so that is a change of who authenticates rather than of what is served.
 */

/** The provider credential slots this Deployment stores, matching the shipped member surface. */
const SECRET_SLOTS = ['anthropic', 'openai', 'openrouter', 'github'] as const;

const refusalStatus = (r: SettingsRefusal): number => (r.reason === 'unauthorized' ? 403 : 400);

/**
 * One refusal shape for this surface.
 *
 * A body fault and a leaf fault both answer 400, so both answer in the same shape:
 * a client keying on `applied` sees every refusal, rather than one kind through
 * `applied` and another through `error`.
 */
const refused = (r: SettingsRefusal): Response => Response.json({ applied: false, ...r }, { status: refusalStatus(r) });

/** A malformed request, in the same shape as every other refusal here. */
const malformed = (leaf: string, reason: string): Response =>
  Response.json({ applied: false, reason: 'malformed', leaf, detail: reason }, { status: 400 });

/** The writer for this request, carrying whatever step-up authority the caller presented. */
function writerFor(env: ServerEnv, ctx: OwnerContext) {
  const presented = ctx.request.headers.get(STEP_UP_HEADER);
  return settingsWriter(env.db, {
    authorize: stepUpAuthorizer(env.db, requiresStepUp, () => presented, () => ctx.now),
  });
}

/**
 * A JSON object body, or null for anything else.
 *
 * `null` is valid JSON, so `request.json()` resolves for it and a later property
 * read throws — which the owner catch turns into a 503 with retry-after. A
 * malformed body is the caller's own fault and must be terminal, so the shape is
 * checked here rather than discovered by dereferencing it.
 */
async function jsonObject(ctx: OwnerContext): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await ctx.request.json();
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * The longest credential this surface accepts.
 *
 * A ceiling rather than the body cap alone: provider credentials are of the order
 * of a hundred characters, and a bounded refusal is terminal where an unbounded
 * value is a large sealed row nothing can use.
 */
const MAX_SECRET_CHARS = 4096;

/** Spends the step-up authority a credential change requires, from the header carrying it. */
async function spentForCredential(env: ServerEnv, ctx: OwnerContext): Promise<boolean> {
  const presented = ctx.request.headers.get(STEP_UP_HEADER);
  if (presented === null) return false;
  return (await spendStepUpAuthority(env.db, presented, 'provider_credential', ctx.member.id, ctx.now)).ok;
}

/** Every Deployment leaf this server accepts, with whatever is stored for it. A leaf with no row is reported absent rather than defaulted — the reader layers its own defaults. */
export async function handleSettings(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const stored = await settingsWriter(env.db).leaves();
  return ok({
    leaves: DEPLOYMENT_LEAVES.map((leaf) => ({
      leaf,
      configured: leaf in stored,
      value: stored[leaf] ?? null,
      requiresStepUp: requiresStepUp(leaf),
    })),
  });
}

/** Set one Deployment leaf. */
export async function handleSetSetting(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await jsonObject(ctx);
  if (body === null || !('value' in body)) return malformed(ctx.params.leaf, 'body must be a JSON object carrying a value');

  const result = await writerFor(env, ctx).setLeaf(ctx.params.leaf, body.value, ctx.member.id, ctx.now);
  return result.applied ? ok({ applied: true }) : refused(result.refusal);
}

/** What this Project is admitted to. Every capability is reported, so an absent row reads as `false` rather than as missing. */
export async function handleProjectCapabilities(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ capabilities: await settingsWriter(env.db).capabilities(ctx.params.projectId) });
}

/** Admit or withdraw one capability for one Project. */
export async function handleSetProjectCapability(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const body = await jsonObject(ctx);
  if (body === null || typeof body.enabled !== 'boolean') return malformed(`project.${ctx.params.capability}`, 'body must carry a boolean `enabled`');

  const result = await writerFor(env, ctx)
    .setCapability(ctx.params.projectId, ctx.params.capability, body.enabled, ctx.member.id, ctx.now);
  return result.applied ? ok({ applied: true }) : refused(result.refusal);
}

/**
 * What is configured, never what it is.
 *
 * The list is the fixed slot set rather than whatever happens to be stored, so a
 * surface renders the same rows on a fresh Deployment as on a configured one and
 * an absent credential is visibly absent rather than missing from the response.
 */
export async function handleSecrets(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const store = deploymentSecretStore(env.db, env.wrappingKey);
  const described = await Promise.all(SECRET_SLOTS.map(async (name) => ({ name, ...(await store.describe(name)) })));
  return ok({ secrets: described });
}

/**
 * Store a provider credential. The value is written and never returned.
 *
 * Step-up gated, and the risk it answers is SUBSTITUTION rather than disclosure.
 * The stored value is already write-only and masked, so a member cannot read the
 * Deployment's key — but a member who writes their OWN key into the `anthropic`
 * slot has every later intelligence run dispatched against an account they
 * control and can read. That is the same outcome as redirecting the endpoint,
 * reached through the slot #907 named first.
 */
export async function handleSetSecret(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(SECRET_SLOTS as readonly string[]).includes(ctx.params.name)) return notFound();
  const body = await jsonObject(ctx);
  const slot = `secret.${ctx.params.name}`;
  if (body === null || typeof body.value !== 'string' || body.value.length === 0) return malformed(slot, 'body must carry a non-empty string `value`');
  if (body.value.length > MAX_SECRET_CHARS) return malformed(slot, `value must be at most ${MAX_SECRET_CHARS} characters`);
  if (!(await spentForCredential(env, ctx))) return refused({ reason: 'unauthorized', leaf: `secret.${ctx.params.name}` });

  await deploymentSecretStore(env.db, env.wrappingKey).put(ctx.params.name, body.value, ctx.member.id, ctx.now);
  // The answer is the description, so a caller that just wrote a value learns only
  // what every other reader may learn about it.
  const description: SecretDescription = await deploymentSecretStore(env.db, env.wrappingKey).describe(ctx.params.name);
  return ok({ name: ctx.params.name, ...description });
}

/**
 * Remove a stored provider credential.
 *
 * Gated with the write. Removal is the quieter half of the same authority: it
 * silences Deployment intelligence, and a member who can do it unauthenticated can
 * do it repeatedly.
 */
export async function handleDeleteSecret(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(SECRET_SLOTS as readonly string[]).includes(ctx.params.name)) return notFound();
  if (!(await spentForCredential(env, ctx))) return refused({ reason: 'unauthorized', leaf: `secret.${ctx.params.name}` });
  return ok(await deploymentSecretStore(env.db, env.wrappingKey).delete(ctx.params.name, ctx.member.id, ctx.now));
}

export { SECRET_SLOTS, PROJECT_CAPABILITIES, type ProjectCapability };
