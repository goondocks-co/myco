import type { ReactNode } from 'react';
import { Button } from '../primitives/Button';
import { ErrorState, errorWords } from './ErrorState';
import { LoadingState } from './LoadingState';

export interface ReadStateProps<T> {
  data: T | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  label: string;
  children: (data: T) => ReactNode;
}

/** An unavailable fact in an otherwise successful server answer. */
export function ReadUnavailable({ label, onRetry }: { label: string; onRetry: () => void }) {
  return <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-muted">
    <span>Couldn’t read {label}.</span>
    <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>
  </div>;
}

/** A read's initial failure or retained data with a failed refresh, alongside its retry. */
export function ReadState<T>({ data, pending, error, onRetry, label, children }: ReadStateProps<T>) {
  if (data === undefined) return pending
    ? <LoadingState label={`Reading ${label}`} count={2} />
    : <ErrorState error={error} onRetry={onRetry}><p>Couldn’t read {label}.</p></ErrorState>;
  return <>
    {Boolean(error) && <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-muted" data-read-stale="">
      <span>Showing the last successful {label} read. Couldn’t refresh it.</span>
      {errorWords(error).retry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>}
    {children(data)}
  </>;
}
