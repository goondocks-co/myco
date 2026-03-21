import type { LogRingBuffer } from '../log-buffer.js';
import type { LogLevel } from '../logger.js';
import type { RouteResponse } from '../router.js';

export async function handleGetLogs(
  ringBuffer: LogRingBuffer,
  query: Record<string, string>,
): Promise<RouteResponse> {
  const since = query.since || null;
  const level = query.level as LogLevel | undefined;
  const limit = query.limit ? parseInt(query.limit, 10) : undefined;

  const result = ringBuffer.since(since, { level, limit: isNaN(limit as number) ? undefined : limit });

  // Map `component` to `category` in the response entries —
  // the logger uses `component` internally; the API spec uses `category`
  const entries = result.entries.map((entry) => {
    const { component, ...rest } = entry;
    return { ...rest, category: component };
  });

  return {
    body: {
      entries,
      cursor: result.cursor,
      ...(result.cursor_reset ? { cursor_reset: true } : {}),
    },
  };
}
