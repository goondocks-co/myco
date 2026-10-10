import type { CloudflareBindings, DeferredWork } from '../../packages/myco-server/src/platform/cloudflare/env.ts';
import { PARITY_REQUEST_HEADER, PARITY_WORKER_HEADER } from './requests.ts';

interface Worker {
  fetch(request: Request, bindings: CloudflareBindings, deferred?: DeferredWork): Promise<Response>;
}

/** Marks responses produced by the Worker separately from the dev proxy's responses. */
export function observedWorker<T extends Worker>(worker: T): T {
  return { ...worker, async fetch(request, bindings, deferred) {
    const id = request.headers.get(PARITY_REQUEST_HEADER);
    const path = new URL(request.url).pathname;
    if (id) console.log(JSON.stringify({ kind: 'parity_request', id, method: request.method, path }));
    try {
      const response = await worker.fetch(request, bindings, deferred);
      if (!id) return response;
      console.log(JSON.stringify({ kind: 'parity_response', id, status: response.status }));
      const marked = new Response(response.body, response);
      marked.headers.set(PARITY_WORKER_HEADER, id);
      return marked;
    } catch (error) {
      console.error(JSON.stringify({ kind: 'parity_exception', id, path, error: error instanceof Error ? error.stack : String(error) }));
      throw error;
    }
  } };
}
