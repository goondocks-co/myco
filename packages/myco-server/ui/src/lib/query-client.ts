import { focusManager, QueryCache, QueryClient } from '@tanstack/react-query';
import { ApiError, SignedOutError } from './api';

/** The query key the auth gate reads; every other query's 401 hands the view back to it. */
export const ME_KEY = ['me'] as const;

/**
 * The one query client the dashboard runs on. A session that ends while the
 * dashboard is open surfaces as a 401 on some later read; re-asking `/auth/me`
 * hands the whole view back to the gate — and `/auth/me`'s own 401 asks nothing
 * again, or a signed-out visitor's browser would ask forever.
 */
/**
 * A 4xx is the server's answer to the request as made — a missing session, a
 * refused write, a signed-out visitor — and is a state to render, never a
 * request to ask again. A 5xx or a connection that never answered is asked
 * twice more while the tab is in view. A retry waits for the tab to be in view,
 * so one asked from a hidden tab would hold its page on the loading state for
 * as long as the tab stays hidden: there the failure is rendered at once, and
 * the refetch a returning tab makes asks again.
 */
export function shouldRetry(count: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status < 500) return false;
  if (!focusManager.isFocused()) return false;
  return count < 2;
}

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
        retry: shouldRetry,
        ...(overrides.retryDelay === undefined ? {} : { retryDelay: overrides.retryDelay }),
      },
    },
  });
  return client;
}
