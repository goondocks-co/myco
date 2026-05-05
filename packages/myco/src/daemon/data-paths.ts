import path from 'node:path';
import { vaultDbPath } from '@myco/db/client.js';
import { requestContextFromEnvironment, type MycoRequestContext } from '@myco/tools/request-context.js';
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

export function resolveDaemonDataPaths(
  vaultDir: string,
  env: Record<string, string | undefined> = process.env,
): DaemonDataPaths {
  const requestContext = requestContextFromEnvironment(env, vaultDir);
  const usingGrove = Boolean(requestContext.groveId);
  return {
    requestContext,
    databasePath: requestContext.databasePath,
    vectorsPath: requestContext.groveId
      ? resolveGroveVectorsPath(requestContext.groveId)
      : path.join(vaultDir, GROVE_VECTORS_FILENAME),
    usingGrove,
  };
}

export function resolveLegacyDaemonDataPaths(vaultDir: string): Pick<DaemonDataPaths, 'databasePath' | 'vectorsPath'> {
  return {
    databasePath: vaultDbPath(vaultDir),
    vectorsPath: path.join(vaultDir, GROVE_VECTORS_FILENAME),
  };
}
