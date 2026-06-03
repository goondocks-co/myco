import { queryLogs } from '../logs/reader.js';
import type { LogQuery, LogQueryResult } from '../logs/reader.js';
import { resolveDaemonLogDir } from '../daemon/service-state.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';

export async function handleMycoLogs(
  vaultDir: string,
  input: LogQuery,
  requestContext?: MycoRequestContext,
): Promise<LogQueryResult> {
  const logDir = resolveDaemonLogDir(vaultDir, { requestContext, env: process.env });
  return queryLogs(logDir, input);
}
