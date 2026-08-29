import { useLocation } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useMe } from '../hooks/use-me';
import { SignedOutError } from '../lib/api';
import { readPendingLink } from '../lib/pending-link';
import { SignedOut } from '../pages/SignedOut';

/** A blank, theme-painted surface: nothing of the application is on it. */
export function Splash() {
  return <div aria-busy="true" aria-label="Loading" className="min-h-screen bg-background" />;
}

/** The server did not answer `/auth/me` with a session state at all; nothing is shown but a way to try again. */
export function Unreachable({ retry }: { retry: () => void }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background text-center">
      <h1 className="font-serif text-2xl text-on-surface">This server is not answering</h1>
      <p className="max-w-md font-sans text-sm text-on-surface-variant">The dashboard could not find out whether you are signed in.</p>
      <button type="button" onClick={retry} className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90">
        Try again
      </button>
    </div>
  );
}

/**
 * The one place the session state is decided for the whole application.
 *
 * Nothing under it mounts until `GET /auth/me` has answered: no navigation, no
 * page, no data request. Signed out, the sign-in page is all there is; a
 * server that does not answer gets the unreachable state. `/link` is the one
 * path rendered whatever the answer — it holds an identity-link key that must
 * survive the sign-in the visitor is about to do, and it decides its own
 * states from the same query.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const me = useMe();
  const location = useLocation();
  if (location.pathname === '/link' || (location.pathname === '/' && readPendingLink() !== null)) return <>{children}</>;
  if (me.isPending) return <Splash />;
  if (me.error instanceof SignedOutError) return <SignedOut />;
  if (me.error) return <Unreachable retry={() => { void me.refetch(); }} />;
  return <>{children}</>;
}
