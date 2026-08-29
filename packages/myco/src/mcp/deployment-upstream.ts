/**
 * The Deployment as an MCP upstream: where the member's tool calls go when
 * the command declares a credential source.
 *
 * `myco mcp --credential registry|env` and `myco tool … --credential …` reach
 * the Deployment's `/mcp` over the member credential — the same record the
 * hooks capture with — and never the local daemon. The source is declared on
 * the command line, as it is for every member hook (`member/credential.ts`),
 * so a settings block cannot redirect a bridge that was installed for the
 * registry. Nothing here refreshes a credential: the hooks' refresh path is
 * the one writer of the registry entry, and a bridge that meets a stale token
 * re-reads the entry the next time it rebuilds its upstream.
 */
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER, type CredentialSource } from '../member/constants.js';
import { parseCredentialFlag, resolveCredential, type CredentialRecord } from '../member/credential.js';
import { CREDENTIAL_FLAG, CREDENTIAL_SOURCES } from '../member/constants.js';

export const MCP_PATH = '/mcp';
export const HEALTH_PATH = '/health';

/** The headers every request to the Deployment carries: the credential, the member protocol, and the Project it acts on. */
export function deploymentHeaders(record: Pick<CredentialRecord, 'token' | 'projectId'>): Record<string, string> {
  return {
    authorization: `Bearer ${record.token}`,
    [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL),
    [PROJECT_HEADER]: record.projectId,
  };
}

export interface DeploymentUpstream {
  mcpUrl: URL;
  healthUrl: URL;
  headers: Record<string, string>;
  /** Where the credential came from, for the bridge's own log line. */
  source: CredentialSource;
  projectId: string;
}

/** The Deployment upstream for the declared source, or null (with the member's stderr diagnostic) when no credential resolves. */
export function resolveDeploymentUpstream(
  source: CredentialSource,
  opts: { cwd?: string; env?: NodeJS.ProcessEnv; mycoHome?: string } = {},
): DeploymentUpstream | null {
  const record = resolveCredential(source, opts);
  if (record === null) return null;
  const base = record.serverUrl.replace(/\/+$/, '');
  return {
    mcpUrl: new URL(`${base}${MCP_PATH}`),
    healthUrl: new URL(`${base}${HEALTH_PATH}`),
    headers: deploymentHeaders(record),
    source,
    projectId: record.projectId,
  };
}

/** A fresh client transport to the Deployment's `/mcp`, carrying the member headers on every request. */
export function deploymentTransport(upstream: DeploymentUpstream, extraHeaders: Record<string, string> = {}): StreamableHTTPClientTransport {
  return new StreamableHTTPClientTransport(upstream.mcpUrl, { requestInit: { headers: { ...upstream.headers, ...extraHeaders } } });
}

/** True when the Deployment answers its health route. */
export async function probeDeploymentHealth(healthUrl: URL): Promise<boolean> {
  try {
    const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** True when the command line carries the credential flag at all, whatever its value. */
export const credentialFlagPresent = (argv: readonly string[]): boolean => argv.some((arg) => arg === CREDENTIAL_FLAG || arg.startsWith(`${CREDENTIAL_FLAG}=`));

/**
 * The credential source a command line declares: a known source; null when
 * the flag is absent (the caller takes the local daemon path); a thrown error
 * when the flag is present with a value that is not a source — a mistyped
 * flag must never fall through to the daemon in silence.
 */
export function declaredCredentialSource(argv: readonly string[]): CredentialSource | null {
  const source = parseCredentialFlag(argv);
  if (source === null && credentialFlagPresent(argv)) {
    throw new Error(`${CREDENTIAL_FLAG} must be one of ${CREDENTIAL_SOURCES.join('|')}`);
  }
  return source;
}

/** Bridge and Deployment liveness: how often the bridge asks the Deployment for its health while idle. Far looser than the daemon's cadence — every probe is a metered request to a remote. */
export const DEPLOYMENT_HEARTBEAT_INTERVAL_MS = 60_000;
/** How many rebuild attempts the bridge makes against a Deployment that stopped answering before it answers the agent's waiting request with an error and keeps serving. */
export const DEPLOYMENT_SELF_HEAL_MAX_ATTEMPTS = 8;
