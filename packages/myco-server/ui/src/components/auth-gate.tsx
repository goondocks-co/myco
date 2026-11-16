import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Button, ReadState } from '../design';
import { useMe } from '../hooks/use-me';
import { ApiError, SignedOutError } from '../lib/api';
import { readPendingLink } from '../lib/pending-link';
import { SignedOut } from '../pages/SignedOut';

/** The paths rendered whether or not anyone is signed in. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/link', '/join', '/device']);
/** The public paths that show the same thing to everyone, so never ask who is signed in. */
const SESSIONLESS_PATHS: ReadonlySet<string> = new Set(['/join']);

/** Visible progress while the first session read is pending. */
function Splash() {
  return <div role="status" aria-busy="true" aria-label="Loading" className="flex min-h-screen flex-col items-center justify-center gap-s4 bg-bg p-gutter text-center">
    <p className="t-display text-ink">Checking your sign-in…</p>
    <p className="max-w-measure t-body text-muted">Connecting to Myco.</p>
  </div>;
}

/** A failed session read keeps its recovery visible until Myco answers. */
function Unreachable({ retry }: { retry: () => void }) {
  return (
    <main role="alert" className="flex min-h-screen flex-col items-center justify-center gap-s4 bg-bg p-gutter text-center">
      <h1 className="t-display text-ink">Myco is restarting or unreachable</h1>
      <p className="max-w-measure t-body text-muted">Your sign-in could not be checked. Myco will try again automatically.</p>
      <Button variant="primary" onClick={retry}>Try again</Button>
    </main>
  );
}

/**
 * The one place the session state is decided for the whole application.
 *
 * Nothing under it mounts until `GET /auth/me` has answered: no navigation, no
 * page, no data request. Signed out, the sign-in page is all there is; a
 * server that does not answer gets the unreachable state. Two paths render
 * whatever the answer: `/link` holds an identity-link key that must survive the
 * sign-in the visitor is about to do, and decides its own states from the same
 * query; `/join` hands an invitation to a machine, which needs no sign-in, so
 * the session is not even asked there.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const location = useLocation();
  const me = useMe({ enabled: !SESSIONLESS_PATHS.has(location.pathname), recover: true });
  if (me.error instanceof ApiError && me.error.code === 'sign_in_unconfigured') return <SignedOut unconfigured />;
  if (PUBLIC_PATHS.has(location.pathname) || (location.pathname === '/' && readPendingLink() !== null)) return <>{children}</>;
  if (me.error instanceof SignedOutError) return <SignedOut />;
  if ((me.error ?? me.failureReason) && me.data === undefined) return <Unreachable retry={() => { void me.refetch(); }} />;
  if (me.isPending) return <Splash />;
  return <ReadState data={me.data} pending={me.isPending} error={me.error} onRetry={() => void me.refetch()} label="sign-in">{() => children}</ReadState>;
}
