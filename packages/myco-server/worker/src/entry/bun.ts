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
import { socketSourceOf, trustedProxySourceOf, type AddressableServer, type TrustedProxyConfig } from '../platform/bun/source.js';

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
  return {
    fetch: (request: Request) => server.handleRequest(request, env),
    bind: (listening: AddressableServer) => { bound = listening; },
    close: () => { sqlite.close(); },
  };
}

export async function serve(options: BunServerOptions): Promise<{ port: number; stop(): void }> {
  const handler = await createBunHandler(options);
  // The runtime's own fallback page embeds the thrown message and surrounding
  // source. Nothing this server answers may disclose either, so the fallback is
  // turned off and replaced with the same bodiless refusal the core would give.
  const server = Bun.serve({
    port: options.port ?? 8787,
    development: false,
    error: () => new Response(null, { status: 503 }),
    fetch: handler.fetch,
  });
  handler.bind(server);
  return { port: Number(server.port), stop: () => { server.stop(); handler.close(); } };
}
