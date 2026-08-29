/**
 * The self-hosted entry point: wiring only.
 *
 * It assembles a `ServerEnv` from the storage an operator mounted and hands every
 * request to the same shared handler the hosted entry point uses. Every behavior
 * lives in the core; nothing here decides anything.
 *
 * It does not apply migrations. A deployment is migrated by its own lifecycle
 * command, and this refuses to serve an unmigrated volume rather than answering
 * requests against one.
 */
import type { Database } from 'bun:sqlite';
import { createServer } from '../pipeline.js';
import { assertSchemaCurrent, openDatabase } from '../platform/bun/database.js';
import { sweepPartialObjects } from '../platform/bun/blobs.js';
import { serverEnvFromBunConfig, type BunServerConfig } from '../platform/bun/env.js';
import { withStaticAssets } from '../platform/bun/static.js';
import { socketSourceOf, trustedProxySourceOf, type AddressableServer, type TrustedProxyConfig } from '../platform/bun/source.js';
import {
  LOOPBACK_V4,
  LOOPBACK_V6,
  assertBothLoopbackFamiliesBound,
  assertLoopbackLiteral,
  isAllowedLoopbackHost,
} from '../platform/bun/loopback.js';

export interface BunServerOptions extends Omit<BunServerConfig, 'sqlite'>, TrustedProxyConfig {
  /** Path to the SQLite database on the mounted volume. */
  databasePath: string;
  port?: number;
  /**
   * Where the client address comes from. `socket` for a deployment reached
   * directly, which no caller can forge; `proxy` for one behind a reverse proxy,
   * which additionally requires the operator to declare the trusted header. A
   * deployment that declares neither establishes no identity and serves nothing
   * but health, rather than metering traffic by a value a caller chose.
   */
  sourceFrom?: 'socket' | 'proxy';
  /**
   * Which #909 transport this deployment serves.
   *
   * `loopback` is C-local: both loopback literals bound, plus a Host allowlist.
   * A loopback socket answers a request carrying any Host, which a page on this
   * machine uses to steer a browser at the deployment.
   *
   * `proxy` is C-remote: still loopback-bound, keeping the proxy-to-backend leg
   * off the network. The Host is the deployment's public authority, owned by
   * the operator's proxy.
   */
  transport?: 'loopback' | 'proxy';
  /**
   * Which addresses to bind.
   *
   * `loopback` (the default) binds both loopback literals or refuses, which is
   * the host-process shape. `all` binds every address in the current network
   * namespace, which is the container shape: published ports reach the
   * namespace's `eth0`, never its loopback, so a container binding loopback
   * answers nothing. `all` relies on the namespace plus loopback-qualified
   * publishing for the same restriction.
   */
  bind?: 'loopback' | 'all';
  /** Directory holding the dashboard's static build. Absent, the deployment serves no dashboard and answers every unowned path as the server does. */
  uiDir?: string;
}

export interface BunHandler {
  fetch(request: Request): Promise<Response>;
  /** Binds the listening server, which is what can report a socket address. */
  bind(server: AddressableServer): void;
  close(): void;
}

/** The request handler for a self-hosted deployment, without binding a socket, so a test drives it exactly as the hosted entry point is driven. */
export async function createBunHandler(options: BunServerOptions): Promise<BunHandler> {
  const sqlite: Database = openDatabase(options.databasePath);
  try {
    await assertSchemaCurrent(sqlite);
  } catch (err) {
    sqlite.close();
    throw err;
  }
  await sweepPartialObjects(options.blobDir);
  const env = serverEnvFromBunConfig({ ...options, sqlite });
  let bound: AddressableServer | null = null;
  const sourceOf = options.sourceFrom === 'socket' ? socketSourceOf(() => bound) : trustedProxySourceOf(options);
  const server = createServer({ now: () => Date.now(), sourceOf, fetchImpl: fetch });
  const core = (request: Request) => server.handleRequest(request, env);
  return {
    fetch: options.uiDir === undefined ? core : withStaticAssets(options.uiDir, core),
    bind: (listening: AddressableServer) => { bound = listening; },
    close: () => { sqlite.close(); },
  };
}

export async function serve(options: BunServerOptions): Promise<{ port: number; stop(): Promise<void> }> {
  const handler = await createBunHandler(options);
  const loopbackOnly = (options.transport ?? 'loopback') === 'loopback';

  // Resolved after the first bind. Port 0 asks the kernel to choose, and the
  // second family lands on the SAME port: two families on two ports is not one
  // deployment. The Host allowlist compares against this, never the requested
  // value.
  let servingPort = options.port ?? 8787;

  // The runtime's own fallback page embeds the thrown message and surrounding
  // source. Nothing this server answers may disclose either, so the fallback is
  // turned off and replaced with the same bodiless refusal the core would give.
  const fetchImpl = loopbackOnly
    ? (request: Request): Response | Promise<Response> => (
      isAllowedLoopbackHost(request.headers.get('host'), servingPort)
        ? handler.fetch(request)
        // Bodiless. A distinguishing message tells a prober which Host values
        // this deployment answers.
        : new Response(null, { status: 421 })
    )
    : handler.fetch;

  const listen = (hostname: string, port: number) => {
    assertLoopbackLiteral(hostname);
    return Bun.serve({ hostname, port, development: false, error: () => new Response(null, { status: 503 }), fetch: fetchImpl });
  };

  // Both families or none: a half-bound loopback surface leaves the other
  // family free for another process to claim (#835). Anything already bound is
  // torn down, leaving no listener behind a refusal.
  const servers: ReturnType<typeof Bun.serve>[] = [];
  const boundFamilies: string[] = [];
  try {
    if ((options.bind ?? 'loopback') === 'all') {
      const server = Bun.serve({
        hostname: '::', port: servingPort, development: false,
        error: () => new Response(null, { status: 503 }),
        fetch: fetchImpl,
      });
      servingPort = Number(server.port);
      servers.push(server);
    } else {
      for (const family of [LOOPBACK_V4, LOOPBACK_V6]) {
        const server = listen(family, servingPort);
        servingPort = Number(server.port);
        servers.push(server);
        boundFamilies.push(family);
      }
      assertBothLoopbackFamiliesBound(boundFamilies);
    }
  } catch (err) {
    for (const server of servers) server.stop();
    handler.close();
    throw err;
  }

  handler.bind(servers[0]!);
  return {
    port: servingPort,
    /**
     * Drain, then close.
     *
     * `Bun.serve().stop()` stops accepting and resolves once in-flight requests
     * finish. The database handle closes after that resolves. Closing it first
     * leaves a request mid-query against a closed connection, answering 500 to
     * a caller the orchestrator asked to let finish.
     */
    stop: async () => {
      await Promise.all(servers.map((server) => server.stop()));
      handler.close();
    },
  };
}
