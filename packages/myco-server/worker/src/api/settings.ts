import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';
import { deploymentSecretStore, type SecretDescription } from '../core/secrets.js';
import {
  DEPLOYMENT_LEAVES, PROJECT_CAPABILITIES, requiresStepUp, settingsWriter,
  type ProjectCapability, type SettingsRefusal,
} from '../core/settings.js';
import { stepUpAuthorizer } from '../auth/step-up.js';
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

const refused = (r: SettingsRefusal): Response => Response.json({ applied: false, ...r }, { status: refusalStatus(r) });

/** The writer for this request, carrying whatever step-up authority the caller presented. */
function writerFor(env: ServerEnv, ctx: OwnerContext) {
  const presented = ctx.request.headers.get(STEP_UP_HEADER);
  return settingsWriter(env.db, {
    authorize: stepUpAuthorizer(env.db, requiresStepUp, () => presented, () => ctx.now),
  });
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
  let body: { value?: unknown };
  try {
    body = (await ctx.request.json()) as { value?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  if (typeof body !== 'object' || body === null || !('value' in body)) return badRequest('body must carry a value');

  const result = await writerFor(env, ctx).setLeaf(ctx.params.leaf, body.value, ctx.session.sub, ctx.now);
  return result.applied ? ok({ applied: true }) : refused(result.refusal);
}

/** What this Project is admitted to. Every capability is reported, so an absent row reads as `false` rather than as missing. */
export async function handleProjectCapabilities(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  return ok({ capabilities: await settingsWriter(env.db).capabilities(ctx.params.projectId) });
}

/** Admit or withdraw one capability for one Project. */
export async function handleSetProjectCapability(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.session, ctx.params.projectId);
  if (scope === null) return notFound();
  let body: { enabled?: unknown };
  try {
    body = (await ctx.request.json()) as { enabled?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  if (typeof body.enabled !== 'boolean') return badRequest('enabled must be a boolean');

  const result = await writerFor(env, ctx)
    .setCapability(ctx.params.projectId, ctx.params.capability, body.enabled, ctx.session.sub, ctx.now);
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

/** Store a provider credential. The value is written and never returned. */
export async function handleSetSecret(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(SECRET_SLOTS as readonly string[]).includes(ctx.params.name)) return notFound();
  let body: { value?: unknown };
  try {
    body = (await ctx.request.json()) as { value?: unknown };
  } catch {
    return badRequest('body must be JSON');
  }
  if (typeof body.value !== 'string' || body.value.length === 0) return badRequest('value must be a non-empty string');

  await deploymentSecretStore(env.db, env.wrappingKey).put(ctx.params.name, body.value, ctx.session.sub, ctx.now);
  // The answer is the description, so a caller that just wrote a value learns only
  // what every other reader may learn about it.
  const description: SecretDescription = await deploymentSecretStore(env.db, env.wrappingKey).describe(ctx.params.name);
  return ok({ name: ctx.params.name, ...description });
}

/** Remove a stored provider credential. */
export async function handleDeleteSecret(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(SECRET_SLOTS as readonly string[]).includes(ctx.params.name)) return notFound();
  return ok(await deploymentSecretStore(env.db, env.wrappingKey).delete(ctx.params.name, ctx.session.sub, ctx.now));
}

export { SECRET_SLOTS, PROJECT_CAPABILITIES, type ProjectCapability };
