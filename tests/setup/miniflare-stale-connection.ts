import { createRequire } from 'node:module';

const load = createRequire(import.meta.url);
type ProxyFetch = (input: RequestInfo | URL, init?: RequestInit & { session?: Bun.FetchSession }) => Promise<Response>;
type WorkerOptions = { eval?: boolean } & Record<string, unknown>;
type WorkerConstructor = new (script: unknown, options?: WorkerOptions) => object;

/** Source text found only in Miniflare's synchronous bridge script. */
const BRIDGE_SCRIPT_MARKER = 'actualRequire("undici")';
const PROXY_POOL_LIFETIME_MS = 4_000;

/** Proxy pools retire before workerd's five-second idle close; failed writes are never replayed. */
function isolateProxyConnections(undici: { fetch: ProxyFetch }, lifetimeMs: number): () => void {
  const previous = undici.fetch;
  const original = Symbol.for('myco.test.platform-proxy.fetch');
  const send = (undici as typeof undici & { [original]?: ProxyFetch })[original] ?? previous;
  Object.assign(undici, { [original]: send });
  let session = new Bun.FetchSession();
  let openedAt = performance.now();
  undici.fetch = (input, init) => {
    const url = new URL(typeof input === 'object' && 'url' in input ? input.url : String(input));
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.pathname !== '/cdn-cgi/local/platform-proxy') return send(input, init);
    const now = performance.now();
    if (now - openedAt >= lifetimeMs) {
      session.close();
      session = new Bun.FetchSession();
      openedAt = now;
    }
    return send(input, { ...init, session });
  };
  return () => { undici.fetch = previous; session.close(); };
}

/** Applies the same connection policy to async calls and the synchronous bridge's separate worker. */
export function installLocalProxyConnections(lifetimeMs = PROXY_POOL_LIFETIME_MS): () => void {
  const restoreFetch = isolateProxyConnections(load('undici'), lifetimeMs);
  const threads = load('node:worker_threads') as { Worker: WorkerConstructor };
  const OriginalWorker = threads.Worker;
  threads.Worker = class extends OriginalWorker {
    constructor(script: unknown, options?: WorkerOptions) {
      const bridge = options?.eval === true && typeof script === 'string' && script.includes(BRIDGE_SCRIPT_MARKER);
      super(bridge ? `(${isolateProxyConnections.toString()})(require("undici"),${lifetimeMs});\n${script}` : script, options);
    }
  };
  return () => { threads.Worker = OriginalWorker; restoreFetch(); };
}
