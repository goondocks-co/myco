import path from 'node:path';
import { type MycoRequestContext, requestContextFromEnvironment } from '@myco/tools/request-context.js';
import {
  GROVE_VECTORS_FILENAME,
  resolveGroveVectorsPath,
} from '@myco/grove/paths.js';

/**
 * Daemon-side view of the data paths derived from a `MycoRequestContext`.
 *
 * Why this wrapper exists (rather than folding `vectorsPath` and
 * `usingGrove` into `MycoRequestContext` directly):
 *
 * - `MycoRequestContext` is the **shared identity contract** between the
 *   daemon, its tool runtime, and external request callers. It captures
 *   project/grove identity and the path of the database the request must
 *   open. It deliberately stays minimal so non-daemon consumers (CLI,
 *   tools, cloud counterparts) don't carry daemon-only baggage.
 *
 * - `vectorsPath` and `usingGrove` are **daemon-internal derivations**.
 *   `vectorsPath` resolves the embedding-store path through Grove-aware
 *   logic in `@myco/grove/paths`; `usingGrove` is a convenience boolean
 *   for legacy-vault-vs-Grove branching that exists only inside the
 *   daemon process. Pushing them into `MycoRequestContext` would force
 *   every consumer of that contract to know about Grove embedding paths
 *   and to maintain the same derivation logic.
 *
 * Many call sites read `dataPaths.requestContext.X` for project identity
 * and `dataPaths.vectorsPath` / `dataPaths.databasePath` for storage
 * paths in the same expression. That co-access is by design: callers
 * need both identity and paths, and they get them from one place without
 * the request-context contract growing daemon-only fields.
 */
export interface DaemonDataPaths {
  requestContext: MycoRequestContext;
  databasePath: string;
  vectorsPath: string;
  usingGrove: boolean;
}

export function resolveVectorsPathForRequestContext(requestContext: MycoRequestContext): string {
  return requestContext.groveId
    ? resolveGroveVectorsPath(requestContext.groveId)
    : path.join(requestContext.projectVaultDir, GROVE_VECTORS_FILENAME);
}

export function resolveDaemonDataPaths(
  vaultDir: string,
  env: Record<string, string | undefined> = process.env,
): DaemonDataPaths {
  const requestContext = requestContextFromEnvironment(env, vaultDir);
  return {
    requestContext,
    databasePath: requestContext.databasePath,
    vectorsPath: resolveVectorsPathForRequestContext(requestContext),
    usingGrove: Boolean(requestContext.groveId),
  };
}
