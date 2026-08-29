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

/** The credential source a command line declares, or null: the caller then takes the local daemon path. */
export const declaredCredentialSource = (argv: readonly string[]): CredentialSource | null => parseCredentialFlag(argv);
