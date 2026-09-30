import { type ReactNode } from 'react';
import { AlertCircle } from 'lucide-react';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { Button } from '../primitives/Button';
import { ActionLink } from '../primitives/Link';

export interface ErrorWords {
  title: string;
  /** Whether trying again can help. */
  retry: boolean;
}

/**
 * What a failed read says, worded by its status: a refusal names who the page
 * is for, a missing thing says so, a server fault offers a retry, and only a
 * request that never reached the server says it could not be reached. The
 * server's own sentence is never shown: it is written for an operator.
 */
export function errorWords(error: unknown): ErrorWords {
  if (error instanceof ApiError) {
    if (error.status === 403) return { title: 'This page is for an admin.', retry: false };
    if (error.status === 404) return { title: 'Not found', retry: false };
    if (error.status >= 500) return { title: 'The server had a problem', retry: true };
    return { title: 'The server refused this', retry: false };
  }
  return { title: 'Could not reach the server', retry: true };
}

export interface ErrorStateProps {
  error: unknown;
  onRetry?: () => void;
  /** Where "Back" leads from a missing thing. */
  back?: { to: string; label: string };
  children?: ReactNode;
  className?: string;
}

/** A failed read: what failed, in words chosen by status, and the way on. Never endless loading. */
export function ErrorState({ error, onRetry, back, children, className }: ErrorStateProps) {
  const words = errorWords(error);
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-s3 rounded-card border border-line bg-surface-1 p-s6', className)}>
      <div className="flex items-center gap-s2 t-h3 text-ink">
        <AlertCircle aria-hidden className="size-s5 text-bad" />
        {words.title}
      </div>
      {children}
      <div className="flex gap-s2">
        {words.retry && onRetry && <Button onClick={onRetry}>Retry</Button>}
        {back && <ActionLink to={back.to}>{back.label}</ActionLink>}
      </div>
    </div>
  );
}
