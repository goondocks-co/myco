import { QueryCache, QueryClient } from '@tanstack/react-query';
import { SignedOutError } from './api';

/** The query key the auth gate reads; every other query's 401 hands the view back to it. */
export const ME_KEY = ['me'] as const;

/**
 * The one query client the dashboard runs on. A missing session is a state to
 * render, never a request to retry. A session that ends while the dashboard is
 * open surfaces as a 401 on some later read; re-asking `/auth/me` hands the
 * whole view back to the gate — and `/auth/me`'s own 401 asks nothing again,
 * or a signed-out visitor's browser would ask forever.
 */
export function createQueryClient(overrides: { retryDelay?: number } = {}): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (error instanceof SignedOutError && query.queryKey[0] !== ME_KEY[0]) void client.invalidateQueries({ queryKey: ME_KEY });
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (count, error) => !(error instanceof SignedOutError) && count < 2,
        ...(overrides.retryDelay === undefined ? {} : { retryDelay: overrides.retryDelay }),
      },
    },
  });
  return client;
}
