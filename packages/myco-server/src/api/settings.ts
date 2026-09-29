import type { ServerEnv } from '../core/adapters.js';
import { machineBlockFor } from '../core/machine-settings.js';
import type { CredentialContext } from '../context.js';
import type { OwnerContext } from '../context.js';
import { emptyBodyRoute } from '../auth/members.js';
import { isAdmin } from '../auth/roles.js';
import { badRequest, notFound, ok, readJsonObject, resolveProjectScope } from './scope.js';
import { SecretValueError, deploymentSecretStore, type SecretDescription } from '../core/secrets.js';
import { SECRET_SLOT_NAMES } from '@goondocks/myco-shared/secret-slots';
import {
  DEPLOYMENT_LEAVES, PROJECT_CAPABILITIES, settingsWriter,
  type ProjectCapability, type SettingsRefusal,
} from '../core/settings.js';

/**
 * The Deployment Settings surface.
 *
 * Every write here goes through the one validated operation in `core/settings.ts`
 * rather than reaching the store itself — this module decides nothing about what
 * a setting means, only how it is asked for and answered.
 *
 * Any member reads the Deployment's settings, as a member's CLI does over
 * `/members/settings`; only an admin writes one, or reads or writes a credential
 * slot. The route table declares which (`routes.ts`), and the pipeline enforces it.
 */

/** The credential slots this Deployment stores, each with the one use it serves (`secret-slots.ts`). */
const SECRET_SLOTS = SECRET_SLOT_NAMES;

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

/** The writer for this request. Membership is the whole authorization: the write path still validates, persists, and records the actor in one order. */
function writerFor(env: ServerEnv) {
  return settingsWriter(env.db);
}


/**
 * The longest credential this surface accepts.
 *
 * A ceiling rather than the body cap alone: provider credentials are of the order
 * of a hundred characters, and a bounded refusal is terminal where an unbounded
 * value is a large sealed row nothing can use.
 */
const MAX_SECRET_CHARS = 4096;


/**
 * Every Deployment leaf this server accepts, with whatever is stored for it. A leaf with no row is reported absent
 * rather than defaulted: the reader layers its own defaults. `redacted` answers every URL a string value holds, at any
 * depth, without its userinfo, query and fragment (`withoutUrlSecrets`), which is how every reader but an admin gets
 * them; an admin reads them raw to edit them. Provider credentials live in the secret store and never reach this.
 */
async function deploymentLeaves(env: ServerEnv, redacted: boolean): Promise<unknown[]> {
  const stored = await settingsWriter(env.db).leaves();
  const leaves = DEPLOYMENT_LEAVES.map((leaf) => ({
    leaf,
    configured: leaf in stored,
    value: stored[leaf]?.value ?? null,
    updatedAt: stored[leaf]?.updatedAt ?? null,
    updatedBy: stored[leaf]?.updatedBy ?? null,
  }));
  if (!redacted) return leaves;
  return JSON.parse(JSON.stringify(leaves), (_key, value: unknown) => (typeof value === 'string' ? withoutUrlSecrets(value) : value)) as unknown[];
}

/** `GET /api/settings`: the Deployment's leaves on the dashboard, raw to an admin and redacted to every other member. */
export async function handleSettings(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return ok({ persisted: true, leaves: await deploymentLeaves(env, !isAdmin(ctx.member.role)) });
}

/** A token that addresses a host: a scheme or `//` ahead of it, or `name:secret@host` followed by a port or a path. */
const URL_TOKEN = /^(?:[a-z][\w+.-]*:)?\/\/|^[^:/@]+:[^/@]*@[\w.-]+[:/]/i;
/** The userinfo of a URL token, with the scheme and `//` it follows kept in group 1. */
const USERINFO = /^((?:[a-z][\w+.-]*:)?\/\/)?[^/@?#]*@/i;

/**
 * A string with every URL inside it — whole, embedded in prose, or inside a
 * JSON-encoded value — stripped of its userinfo, query and fragment. Tokens
 * are split at whitespace, quotes, brackets, commas and backslashes.
 */
const withoutUrlSecrets = (value: string): string =>
  value.replace(/[^\s"'<>(),\\]+/g, (token) => (URL_TOKEN.test(token) ? token.replace(USERINFO, '$1').replace(/[?#].*$/, '') : token));

/**
 * The same leaves to a member credential, Deployment-wide, over a member json
 * route whose body is the empty object. Every URL a string value holds, at any
 * depth and anywhere in the string, leaves without its userinfo, query and
 * fragment.
 */
export const handleMemberSettings = emptyBodyRoute(async (env: ServerEnv, ctx: CredentialContext) => {
  const deployment = { persisted: true, leaves: await deploymentLeaves(env, true) };
  // The asking machine's own settings, where its member claims it: what `myco login`, `member join` and `cutover` cache.
  const machine = await machineBlockFor(env.db, ctx.memberId, ctx.machineId);
  return ok({ ...deployment, ...(machine === null ? {} : { machine }) });
});

/** Set one Deployment leaf. */
export async function handleSetSetting(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  if (body === null || !('value' in body)) return malformed(ctx.params.leaf, 'body must be a JSON object carrying a value');

  const result = await writerFor(env).setLeaf(ctx.params.leaf, body.value, ctx.member.id, ctx.now);
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
  const body = await readJsonObject(ctx.request);
  if (body === null || typeof body.enabled !== 'boolean') return malformed(`project.${ctx.params.capability}`, 'body must carry a boolean `enabled`');

  const result = await writerFor(env)
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
 * A member session is the whole authorization. The risks that matter are answered
 * in structure: the stored value is write-only and masked, a credentialed
 * provider's key travels only to its provider's own fixed endpoint, and every
 * write records its actor.
 */
export async function handleSetSecret(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (!(SECRET_SLOTS as readonly string[]).includes(ctx.params.name)) return notFound();
  const body = await readJsonObject(ctx.request);
  const slot = `secret.${ctx.params.name}`;
  if (body === null || typeof body.value !== 'string' || body.value.length === 0) return malformed(slot, 'body must carry a non-empty string `value`');
  if (body.value.length > MAX_SECRET_CHARS) return malformed(slot, `value must be at most ${MAX_SECRET_CHARS} characters`);

  try {
    await deploymentSecretStore(env.db, env.wrappingKey).put(ctx.params.name, body.value, ctx.member.id, ctx.now);
  } catch (error) {
    if (error instanceof SecretValueError) return malformed(slot, error.reason);
    throw error;
  }
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
  return ok(await deploymentSecretStore(env.db, env.wrappingKey).delete(ctx.params.name, ctx.member.id, ctx.now));
}

export { SECRET_SLOTS, PROJECT_CAPABILITIES, type ProjectCapability };
