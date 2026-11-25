import { useRef } from 'react';

/** The parts of a query a held read weighs. */
export interface QueryRead<T> {
  data: T | undefined;
  error: unknown;
  isPending: boolean;
  /** When the query last failed; zero when it never has. */
  errorUpdatedAt: number;
}

/** A read as a page shows it: its answer, the error of its last failed read, and whether it has neither answered nor failed yet. */
export interface HeldRead<T> {
  data: T | undefined;
  error: unknown;
  pending: boolean;
}

/**
 * A query whose read failed while it has no answer keeps its failure, with the error this page saw, while it is tried
 * again; it reads as pending only until it first answers or fails here. A query with an answer keeps it, and its own
 * error, as it refreshes.
 */
export function useHeldRead<T>(query: QueryRead<T>): HeldRead<T> {
  const last = useRef<unknown>(null);
  if (query.error !== null) last.current = query.error;
  const held = query.error === null && query.data === undefined && query.errorUpdatedAt > 0 ? last.current : null;
  return { data: query.data, error: query.error ?? held, pending: query.isPending && held === null };
}
