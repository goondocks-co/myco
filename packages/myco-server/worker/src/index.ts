import type { Env } from './env.js';
import { createServer } from './pipeline.js';
import { cloudflareSourceOf } from './platform/cloudflare.js';

const server = createServer({ now: () => Date.now(), sourceOf: cloudflareSourceOf });

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  return server.handleRequest(request, env);
}

export default { fetch: handleRequest };
