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
import {
  declaredCredentialSource, deploymentTransport, probeDeploymentHealth, resolveDeploymentUpstream, type DeploymentUpstream,
} from '../mcp/deployment-upstream.js';
import { unboundedBudget } from '../member/budget.js';
import type { CredentialSource } from '../member/constants.js';
import { resolveMemberProjectRoot } from '../member/credential.js';
import { REJOIN_HINT } from '../member/delivery-notice.js';
import { refreshMemberCredential, type RefreshStatus } from '../member/refresh.js';
import { readRegistryEntryResult, registryEntryPath } from '../member/registry.js';
import type { FetchLike } from '../member/transport.js';
import { resolveMycoHome } from '../paths/home.js';

export interface MemberVerbDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  mycoHome?: string;
  fetch?: FetchLike;
  now?: () => number;
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
const RENEWAL_TERMINAL: readonly RefreshStatus[] = ['unauthorized', 'terminal', 'lineage-expired'];

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

const upstreamFor = (source: CredentialSource, deps: MemberVerbDeps): DeploymentUpstream | null =>
  resolveDeploymentUpstream(source, { cwd: cwdOf(deps), env: envOf(deps), mycoHome: homeOf(deps), invokedBy: 'cli' });

/** A member json route's answer: its body, or the refusal it carries in the route's shape. */
async function postRoute(upstream: DeploymentUpstream, fetchImpl: FetchLike, path: string, body: Record<string, unknown>): Promise<DeploymentOutcome<Record<string, unknown>>> {
  const url = new URL(`${upstream.healthUrl.href.replace(/\/health$/, '')}${path}`);
  let res: Response;
  try {
    res = await fetchImpl(url, { method: 'POST', headers: { ...upstream.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (error) {
    return { ok: false, error: { code: 'unreachable', message: (error as Error).message } };
  }
  if (res.status === 401) return { ok: false, error: { code: 'unauthorized', message: 'The Deployment refused the credential (HTTP 401).' } };
  let answer: Record<string, unknown>;
  try {
    answer = await res.json() as Record<string, unknown>;
  } catch {
    return { ok: false, error: { code: 'unavailable', message: `The Deployment answered HTTP ${res.status} with no JSON body.` } };
  }
  if (!res.ok || typeof answer.code === 'string') {
    return { ok: false, error: { code: typeof answer.code === 'string' ? answer.code : 'unavailable', message: typeof answer.reason === 'string' ? answer.reason : `HTTP ${res.status}` } };
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
  let upstream = upstreamFor(source, deps);
  if (upstream === null) return null;
  const fetchImpl: FetchLike = deps.fetch ?? globalThis.fetch;
  let renewedAfterRefusal = false;

  /** Run one request, and once after a 401 on an unchanged registry credential renew it and run it again. */
  const withRenewal = async <T>(attempt: (at: DeploymentUpstream) => Promise<DeploymentOutcome<T>>): Promise<DeploymentOutcome<T>> => {
    const first = await attempt(upstream!);
    if (first.ok || first.error.code !== 'unauthorized' || source !== 'registry' || renewedAfterRefusal) return first;
    renewedAfterRefusal = true;
    const presented = upstream!.headers.authorization;
    const status = await renew(deps, true);
    const next = upstreamFor(source, deps);
    if (next === null || next.headers.authorization === presented) {
      return { ok: false, error: { code: 'unauthorized', message: RENEWAL_TERMINAL.includes(status) || renewalEnded(deps)
        ? `the Deployment refused this machine's credential and it cannot be renewed — ${REJOIN_HINT}`
        : `the Deployment refused this machine's credential and it could not be renewed yet (${status}); try again shortly` } };
    }
    upstream = next;
    return attempt(upstream);
  };

  const transport = (at: DeploymentUpstream) => deploymentTransport(at, {}, deps.fetch);
  return {
    serverUrl: upstream.healthUrl.href.replace(/\/health$/, ''),
    projectId: upstream.projectId,
    healthy: async () => {
      if (deps.fetch === undefined) return probeDeploymentHealth(upstream!.healthUrl);
      try {
        return (await deps.fetch(upstream!.healthUrl)).ok;
      } catch {
        return false;
      }
    },
    call: (tool, args) => withRenewal((at) => callTool(transport(at), tool, args)),
    listTools: () => withRenewal((at) => withMcpClient(transport(at), async (client) => (await client.listTools()).tools.map((t) => t.name))),
    post: (path, body) => withRenewal((at) => postRoute(at, fetchImpl, path, body)),
  };
}
