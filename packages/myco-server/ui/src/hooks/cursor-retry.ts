import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { ApiError } from '../lib/api';
import { SESSION_READS } from './session-reads';

/** A named cursor expiry discards the whole versioned page set and refreshes its metadata. */
export async function retryCursorRead(client: QueryClient, key: QueryKey, error: unknown, retry: () => unknown) {
  if (!(error instanceof ApiError) || error.code !== 'stale_cursor') { retry(); return; }
  await client.cancelQueries({ queryKey: key, exact: true });
  if (SESSION_READS.some(read => read === key[0])) {
    const parents: QueryKey[] = [['session', key[1], key[2]]];
    if (key[0] === 'turn' && key[4] === 'collection') parents.push(key.slice(0, 4));
    await Promise.all(parents.map(queryKey => client.invalidateQueries({ queryKey, exact: true, refetchType: 'all' })));
  }
  await client.resetQueries({ queryKey: key, exact: true });
}
