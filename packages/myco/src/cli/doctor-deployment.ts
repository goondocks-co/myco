import type { DeploymentError, DeploymentOutcome } from '@myco/cli/deployment-reader.js';
import { terminalText } from '@myco/utils/terminal-text.js';
import { classifyMcpError } from '@myco/mcp/client-call.js';
import { withinRequestDeadline, type FetchLike } from '@myco/member/transport.js';
import { memberServerDialUrl } from '@myco/member/server-url.js';
import { HEALTH_PATH } from '@myco/mcp/deployment-upstream.js';
import { connectionFailure } from '@myco/server/object-read.js';

type FailureKind = 'connection' | 'credential' | 'other';
type DoctorOutcome<T> = { ok: true; value: T } | { ok: false; error: DeploymentError; kind: FailureKind };
const CONNECTION_CODES = new Set(['unreachable', 'timeout', 'host_unreachable']);
const CREDENTIAL_CODES = new Set(['unauthorized', 'host_auth_rejected']);
// MCP's generic failure carries the fetch or request deadline's message.
const CONNECTION_MESSAGE = /\b(?:fetch failed|(?:socket|connection|network)[^.\n]*(?:closed|reset|lost|refused)|timed? out|timeout|TimeoutError|DNS[^.\n]*(?:failed|not found|resolve))\b/i;
const DOCTOR_CONNECTION_ATTEMPTS = 2;

function failureKind(error: DeploymentError): FailureKind {
  if (CREDENTIAL_CODES.has(error.code)) return 'credential';
  if (CONNECTION_CODES.has(error.code) || connectionFailure(error)) return 'connection';
  if (error.code === 'tool_call_failed' && (CONNECTION_MESSAGE.test(error.message)
    || error.message.split(/\W+/).some(code => connectionFailure({ code })))) return 'connection';
  return 'other';
}

/** Every Deployment check retries a transport failure once, retaining the final answer. */
export async function doctorDeploymentRequest<T>(request: () => Promise<DeploymentOutcome<T>>): Promise<DoctorOutcome<T>> {
  for (let attempt = 1; ; attempt += 1) {
    let result: DeploymentOutcome<T>;
    try { result = await request(); }
    catch (error) {
      const detail = classifyMcpError(error);
      if (connectionFailure(error)) detail.code = 'unreachable';
      else if (error instanceof Error && error.name === 'AbortError') detail.code = 'timeout';
      result = { ok: false, error: detail };
    }
    if (result.ok) return result;
    const kind = failureKind(result.error);
    if (kind !== 'connection' || attempt >= DOCTOR_CONNECTION_ATTEMPTS) return { ...result, kind };
  }
}

/** Public health checks carry no credential; every attempt gets its own deadline. */
export function doctorDeploymentHealth(serverUrl: string, options: { fetch: FetchLike; timeoutMs: number }): Promise<DoctorOutcome<boolean>> {
  return doctorDeploymentRequest(() => withinRequestDeadline({ connectTimeoutMs: options.timeoutMs, requestTimeoutMs: options.timeoutMs }, async ({ signal }) => {
    const response = await options.fetch(memberServerDialUrl(`${serverUrl.replace(/\/+$/, '')}${HEALTH_PATH}`), { method: 'GET', redirect: 'error', signal })
      .catch(error => { throw signal.aborted ? signal.reason : error; });
    return response.status === 200 ? { ok: true, value: true } : { ok: false, error: { code: 'unavailable', message: `The health route answered HTTP ${response.status}.` } };
  }));
}

/** Recovery follows the failed request's class; only a credential refusal asks for sign-in. */
export function doctorDeploymentFailure(serverUrl: string, failure: Extract<DoctorOutcome<unknown>, { ok: false }>, operation: string): string {
  const detail = `(${terminalText(failure.error.code)}): ${terminalText(failure.error.message)}`;
  if (failure.kind === 'credential') return `${serverUrl} refused ${operation} ${detail}. Run \`myco login ${serverUrl}\`.`;
  if (failure.kind === 'connection') return `${serverUrl} connection problem while requesting ${operation} ${detail}. Check the address and connection, then run \`myco doctor\` again.`;
  return `${serverUrl} could not serve ${operation} ${detail}. Check the Deployment's health and logs, then run \`myco doctor\` again.`;
}
