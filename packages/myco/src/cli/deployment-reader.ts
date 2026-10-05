/**
 * The joined project's Deployment as the member CLI verbs reach it.
 *
 * `memberSource` decides whether a verb has a Deployment to ask: a declared
 * `--credential registry|env` names the source; otherwise a project root the
 * registry holds a membership for reads over the registry; a root with neither
 * has none, and the dispatcher runs the verb's 1.4 handler instead.
 *
 * `openDeployment` answers every request the verbs make — a served tool call,
 * the tool list, a member json route — over the member credential. The
 * registry credential is renewed through the membership's own rotation
 * (`member/refresh.ts`) before the first request when its window is open, and
 * once more after a 401 on a credential no other process has replaced since.
 */
import { callTool, withMcpClient, type ToolCallOutcome } from '../mcp/client-call.js';
import { declaredCredentialSource, deploymentTransport, upstreamOf } from '../mcp/deployment-upstream.js';
import { unboundedBudget, type RequestBudget } from '../member/budget.js';
import { CONNECT_TIMEOUT_CAP_MS, UNBOUNDED_REQUEST_TIMEOUT_MS, type CredentialSource } from '../member/constants.js';
import { ENV_MEMBER_TOKEN, ENV_SERVER_URL, isMemberTokenShape, resolveCredential, resolveMemberProjectRoot, type CredentialRecord } from '../member/credential.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { refreshMemberCredential, refreshMembership, type RefreshStatus } from '../member/refresh.js';
import { deploymentUrl, readDeploymentMembershipResult, readRegistryEntryResult, registryEntryPath } from '../member/registry.js';
import { readDefaultDeployment } from '../member/default-deployment.js';
import { admitMemberServerUrl, MEMBER_SERVER_URL_RULE } from '../member/server-url.js';
import { routeMissing, ServerClient, type FetchLike } from '../member/transport.js';
import { resolveMycoHome } from '../paths/home.js';

export interface MemberVerbDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mycoHome?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** The deadline of each request to a member route or the health route; the member default when absent. */
  requestTimeoutMs?: number;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export const cwdOf = (deps: MemberVerbDeps): string => deps.cwd ?? process.cwd();
export const envOf = (deps: MemberVerbDeps): NodeJS.ProcessEnv => deps.env ?? process.env;
export const homeOf = (deps: MemberVerbDeps): string => deps.mycoHome ?? resolveMycoHome({ cwd: cwdOf(deps), env: envOf(deps) });
export const rootOf = (deps: MemberVerbDeps): string => resolveMemberProjectRoot(cwdOf(deps));

/**
 * The credential source a member verb takes, or null when this invocation has
 * no Deployment to ask: the declared `--credential` source, else `registry`
 * when the registry holds this root's membership — an entry that cannot be
 * read included, so it is reported rather than passed over. A declared value
 * that is not a source throws.
 */
export function memberSource(args: readonly string[], deps: MemberVerbDeps = {}): CredentialSource | null {
  const declared = declaredCredentialSource(args);
  if (declared !== null) return declared;
  return readRegistryEntryResult(rootOf(deps), homeOf(deps)).status === 'missing' ? null : 'registry';
}

/** Renewal answers that leave nothing to retry: the credential is finished until a new one is issued. */
const RENEWAL_TERMINAL: readonly RefreshStatus[] = ['unauthorized', 'terminal', 'lineage-expired', 'non-rotating'];

/** The code of a member route the Deployment does not serve: an older Deployment answers it after authenticating the credential, so no renewal follows. */
export const ROUTE_MISSING = 'route_missing';

/** A failed request, as every Deployment request answers one. */
export interface DeploymentError { code: string; message: string }
export type DeploymentOutcome<T> = ToolCallOutcome<T>;

/** One verb's view of the Deployment: where it is, which Project it acts on, and its requests. */
export interface DeploymentHandle {
  serverUrl: string;
  projectId: string;
  /** Whether the Deployment answers its public health route. */
  healthy: () => Promise<boolean>;
  /** One served tool's full result. */
  call: (tool: string, args: Record<string, unknown>) => Promise<DeploymentOutcome<unknown>>;
  /** The names of the tools the Deployment serves this credential. */
  listTools: () => Promise<DeploymentOutcome<string[]>>;
  /** One member json route's answer body. */
  post: (path: string, body: Record<string, unknown>) => Promise<DeploymentOutcome<Record<string, unknown>>>;
  get: (path: string) => Promise<DeploymentOutcome<Record<string, unknown>>>;
}

/** The registry credential renewed through the membership's own rotation; `force` asks even outside the window. */
async function renew(deps: MemberVerbDeps, force: boolean): Promise<RefreshStatus> {
  const report = await refreshMemberCredential(rootOf(deps), {
    mycoHome: homeOf(deps), budget: unboundedBudget(), force,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  return report.status;
}

/** Whether the registry records this root's credential as finished: a terminal refusal no renewal asks past. */
function renewalEnded(deps: MemberVerbDeps): boolean {
  const read = readRegistryEntryResult(rootOf(deps), homeOf(deps));
  return read.status === 'present' && read.entry.refreshTerminal === true;
}

const credentialFor = (source: CredentialSource, deps: MemberVerbDeps): CredentialRecord | null =>
  resolveCredential(source, { cwd: cwdOf(deps), env: envOf(deps), mycoHome: homeOf(deps), invokedBy: 'cli' });

/** The deadline and redirect policy of every member request (`ServerClient`), with the request deadline a caller may shorten. */
const budgetOf = (deps: MemberVerbDeps): RequestBudget => ({
  connectTimeoutMs: CONNECT_TIMEOUT_CAP_MS,
  requestTimeoutMs: deps.requestTimeoutMs ?? UNBOUNDED_REQUEST_TIMEOUT_MS,
});

/** One renewal policy for project and Deployment requests, with the credential's own single writer. */
function renewedCredential<T extends { token: string }>(initial: T, source: CredentialSource, load: () => T | null, rotate: () => Promise<RefreshStatus>, ended: () => boolean) {
  let record = initial;
  let renewedAfterRefusal = false;
  return {
    current: () => record,
    run: async <R>(attempt: (at: T) => Promise<DeploymentOutcome<R>>): Promise<DeploymentOutcome<R>> => {
      const first = await attempt(record);
      if (first.ok || first.error.code !== 'unauthorized' || source !== 'registry' || renewedAfterRefusal) return first;
      renewedAfterRefusal = true;
      const presented = record.token;
      const status = await rotate();
      const next = load();
      if (next === null || next.token === presented) {
        return { ok: false, error: { code: 'unauthorized', message: RENEWAL_TERMINAL.includes(status) || ended()
          ? `the Deployment refused this machine's credential and it cannot be renewed — ${REJOIN_HINT}`
          : `the Deployment refused this machine's credential and it could not be renewed yet (${status}); try again shortly` } };
      }
      record = next;
      return attempt(record);
    },
  };
}

/** Deployment requests select an explicit server or the recorded default, never a Project inferred from cwd. */
export async function openDeploymentRequests(source: CredentialSource, deps: MemberVerbDeps = {}, server?: string): Promise<DeploymentOutcome<Pick<DeploymentHandle, 'serverUrl' | 'get' | 'post'>>> {
  const home = source === 'registry' ? homeOf(deps) : undefined;
  const budget = budgetOf(deps);
  const env = envOf(deps);
  const serverUrl = source === 'env' ? env[ENV_SERVER_URL]?.trim() : server ?? readDefaultDeployment(home)?.serverUrl;
  const failure = (message: string): DeploymentOutcome<never> => ({ ok: false, error: { code: 'credential_unavailable', message } });
  if (!serverUrl) return failure(source === 'env' ? `set ${ENV_SERVER_URL} and ${ENV_MEMBER_TOKEN}` : 'no default Deployment is recorded; pass --server <url> or sign in with myco login');
  if (!admitMemberServerUrl(serverUrl)) return failure(`the Deployment URL must be ${MEMBER_SERVER_URL_RULE}`);
  if (server !== undefined && deploymentUrl(server) !== deploymentUrl(serverUrl)) return failure('--server must name the Deployment whose credential is supplied');
  const load = (): { serverUrl: string; token: string } | null => {
    if (source === 'env') {
      const token = env[ENV_MEMBER_TOKEN]?.trim();
      return token !== undefined && isMemberTokenShape(token) ? { serverUrl, token } : null;
    }
    const read = readDeploymentMembershipResult(serverUrl, home);
    return read.status === 'present' ? read.membership : null;
  };
  let record = load();
  if (record === null) return failure(source === 'env' ? `set a valid ${ENV_MEMBER_TOKEN}` : 'the selected Deployment membership is missing or unreadable; sign in with myco login');
  const rotate = async (force: boolean) => (await refreshMembership(serverUrl, { mycoHome: home, budget, force, fetch: deps.fetch, now: deps.now })).status;
  if (source === 'registry') { await rotate(false); record = load(); }
  if (record === null) return failure('the selected Deployment membership could not be read after renewal');
  const credential = renewedCredential(record, source, load, () => rotate(true), () => {
    const read = readDeploymentMembershipResult(serverUrl, home);
    return read.status === 'present' && read.membership.refreshTerminal === true;
  });
  const client = (at: { serverUrl: string; token: string }) => new ServerClient(at, deps.fetch ?? globalThis.fetch);
  return { ok: true, value: {
    serverUrl: serverUrl.replace(/\/+$/, ''),
    get: (path) => credential.run((at) => requestRoute(client(at), budget, 'GET', path)),
    post: (path, body) => credential.run((at) => postRoute(client(at), budget, path, body)),
  } };
}

/** A member json route's answer body, or the refusal it carries in the route's shape, under the member request deadline. */
export async function postRoute(client: ServerClient, budget: RequestBudget, path: string, body: Record<string, unknown>): Promise<DeploymentOutcome<Record<string, unknown>>> {
  return requestRoute(client, budget, 'POST', path, body);
}

/** A Deployment-scoped JSON route, under the shared transport and refusal contract. */
async function requestRoute(client: ServerClient, budget: RequestBudget, method: 'GET' | 'POST', path: string, body?: Record<string, unknown>): Promise<DeploymentOutcome<Record<string, unknown>>> {
  const raw = await client.request(method, path, { ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }), budget, scope: 'deployment' });
  if (raw.kind === 'timeout') return { ok: false, error: { code: 'timeout', message: `no answer within ${budget.requestTimeoutMs} ms` } };
  if (raw.kind === 'transport') return { ok: false, error: { code: 'unreachable', message: raw.detail } };
  if (routeMissing(raw)) return { ok: false, error: { code: ROUTE_MISSING, message: `the Deployment does not serve ${path}; update it` } };
  if (raw.status === 401) return { ok: false, error: { code: 'unauthorized', message: 'The Deployment refused the credential (HTTP 401).' } };
  const answer = raw.json;
  if (answer === null) return { ok: false, error: { code: 'unavailable', message: `The Deployment answered HTTP ${raw.status} with no JSON body.` } };
  if (raw.status < 200 || raw.status >= 300 || typeof answer.code === 'string' || answer.persisted === false) {
    return { ok: false, error: { code: typeof answer.code === 'string' ? answer.code : typeof answer.error === 'string' ? answer.error : 'unavailable', message: typeof answer.reason === 'string' ? answer.reason : `HTTP ${raw.status}` } };
  }
  return { ok: true, value: answer };
}

/**
 * Why this root's registry membership cannot be used, in a sentence naming what
 * to do, or null when it can. Checked before the credential is resolved, so an
 * entry that is there and unreadable is never reported as absent, and a
 * command asking for the registry records no missed capture.
 */
export function membershipProblem(deps: MemberVerbDeps = {}): string | null {
  const root = rootOf(deps);
  const home = homeOf(deps);
  const read = readRegistryEntryResult(root, home);
  if (read.status === 'unavailable') {
    return `this project's membership could not be read: ${registryEntryPath(root, home)} is unreadable or names a Deployment membership that is. Repair or remove it, then run \`myco login <link>\`.`;
  }
  if (read.status === 'missing') return `${root} holds no membership under ${home}; run \`myco login <link>\` from this project`;
  return null;
}

/** The Deployment for `source`, or null when no credential resolves: a registry membership `membershipProblem` refuses, or the credential's own stderr line. */
export async function openDeployment(source: CredentialSource, deps: MemberVerbDeps = {}): Promise<DeploymentHandle | null> {
  if (source === 'registry' && membershipProblem(deps) !== null) return null;
  if (source === 'registry') await renew(deps, false);
  const record = credentialFor(source, deps);
  if (record === null) return null;
  const fetchImpl: FetchLike = deps.fetch ?? globalThis.fetch;
  const budget = budgetOf(deps);
  const credential = renewedCredential(record, source, () => credentialFor(source, deps), () => renew(deps, true), () => renewalEnded(deps));

  const transport = (at: CredentialRecord) => deploymentTransport(upstreamOf(at, source), {}, deps.fetch);
  const client = (at: CredentialRecord) => new ServerClient({ serverUrl: at.serverUrl, token: at.token, projectId: at.projectId }, fetchImpl);
  return {
    serverUrl: record.serverUrl.replace(/\/+$/, ''),
    projectId: record.projectId,
    healthy: () => client(credential.current()).health(budget),
    call: (tool, args) => credential.run((at) => callTool(transport(at), tool, args)),
    listTools: () => credential.run((at) => withMcpClient(transport(at), async (client) => (await client.listTools()).tools.map((t) => t.name))),
    post: (path, body) => credential.run((at) => postRoute(client(at), budget, path, body)),
    get: (path) => credential.run((at) => requestRoute(client(at), budget, 'GET', path)),
  };
}
