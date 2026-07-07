/**
 * Team Host — the member→host proxy seam.
 *
 * `handleAttachedRequest` is the seam both inbound dispatch chokepoints
 * (`daemon/server.ts` router path, `mcp/http.ts` raw `/mcp` path) hand a
 * `serve`/`collect` request to once `classifyRoute` has resolved the project as
 * attached. It is invoked BEFORE the request body is read (server.ts) and before
 * any local Grove/DB resolution, so the real forwarder can pipe the raw request
 * stream straight to the host.
 *
 * THIS IS A STUB. Task 1.3 replaces the body with the real
 * `daemon/host-proxy.ts` `HostProxy.forward`: overlay dial, tenancy-header
 * preservation, local→host bearer swap, `x-myco-host-protocol` stamp, the opaque
 * uniform streamed relay, route-keyed flush-before-forward on the capture
 * mining-trigger routes, and the synthesized collector ack. Until then, an
 * attached-project request cannot be forwarded, so we return a structured 503
 * that never touches a local Grove DB — the never-materialize invariant holds
 * even in the stub.
 */
import type http from 'node:http';
import type { RemoteTarget, RouteClassification } from '../host/routing.js';

export async function handleAttachedRequest(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  target: RemoteTarget,
  _classification: RouteClassification,
): Promise<void> {
  res.statusCode = 503;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      error: 'host_proxy_not_implemented',
      host_id: target.host.host_id,
      message:
        `This project is served by host ${target.host.label}, but the member→host proxy `
        + 'is not implemented yet (Task 1.3). The request was not forwarded and no local '
        + 'Grove data was opened.',
      retryable: false,
    }),
  );
}
