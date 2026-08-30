/**
 * The Cloudflare entry point: wiring only.
 *
 * It maps bindings to a `ServerEnv` and hands the request to the one shared
 * handler. Every behavior lives in the core; nothing here decides anything.
 */
import { createServer } from '../pipeline.js';
import { cloudflareSourceOf, serverEnvFromBindings, type CloudflareBindings, type DeferredWork } from '../platform/cloudflare/env.js';

const server = createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf, fetchImpl: (input, init) => fetch(input, init) });

export async function handleRequest(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork): Promise<Response> {
  return server.handleRequest(request, serverEnvFromBindings(bindings, deferred));
}

export default { fetch: handleRequest };
