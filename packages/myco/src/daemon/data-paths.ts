import path from 'node:path';
import { type MycoRequestContext, requestContextFromEnvironment } from '@myco/tools/request-context.js';
import {
  GROVE_VECTORS_FILENAME,
  resolveGroveVectorsPath,
} from '@myco/grove/paths.js';

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
