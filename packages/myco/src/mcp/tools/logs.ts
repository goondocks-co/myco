import { queryLogs } from '../../logs/reader.js';
import type { LogQuery, LogQueryResult } from '../../logs/reader.js';
import path from 'node:path';

export async function handleMycoLogs(
  vaultDir: string,
  input: LogQuery,
): Promise<LogQueryResult> {
  const logDir = path.join(vaultDir, 'logs');
  return queryLogs(logDir, input);
}
