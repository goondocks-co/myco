import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { Button } from '../design';
import { useMe } from '../hooks/use-me';
import { SignedOutError } from '../lib/api';
import { readPendingLink } from '../lib/pending-link';
import { SignedOut } from '../pages/SignedOut';

/** The paths rendered whether or not anyone is signed in. */
const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/link', '/join']);
/** The public paths that show the same thing to everyone, so never ask who is signed in. */
const SESSIONLESS_PATHS: ReadonlySet<string> = new Set(['/join']);

/** A blank, theme-painted surface: nothing of the application is on it. */
export function Splash() {
  return <div aria-busy="true" aria-label="Loading" className="min-h-screen bg-bg" />;
}

/** The server did not answer `/auth/me` with a session state at all; nothing is shown but a way to try again. */
export function Unreachable({ retry }: { retry: () => void }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-s4 bg-bg p-gutter text-center">
      <h1 className="t-display text-ink">This server is not answering</h1>
      <p className="max-w-measure t-body text-muted">The dashboard could not find out whether you are signed in.</p>
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
  const me = useMe({ enabled: !SESSIONLESS_PATHS.has(location.pathname) });
  if (PUBLIC_PATHS.has(location.pathname) || (location.pathname === '/' && readPendingLink() !== null)) return <>{children}</>;
  if (me.isPending) return <Splash />;
  if (me.error instanceof SignedOutError) return <SignedOut />;
  if (me.error) return <Unreachable retry={() => { void me.refetch(); }} />;
  return <>{children}</>;
}
