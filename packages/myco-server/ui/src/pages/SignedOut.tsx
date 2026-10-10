import { SIGN_IN_UNCONFIGURED } from '@goondocks/myco-shared/setup-guidance';
import { buttonVariants } from '../design';

/** Shown when the server answers 401: there is no dashboard session. */
export function SignedOut({ unconfigured = false }: { unconfigured?: boolean }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-s4 bg-bg p-gutter text-center">
      <h1 className="t-display text-ink">{unconfigured ? 'Set up GitHub sign-in' : 'Sign in to Myco'}</h1>
      <p className="max-w-measure t-body text-muted">
        {unconfigured ? SIGN_IN_UNCONFIGURED(window.location.origin) : 'This Myco keeps your projects’ memory. Sign in with the GitHub account linked to your membership to see it.'}
      </p>
      {!unconfigured && <a href="/auth/login" className={buttonVariants({ variant: 'primary' })}>Sign in with GitHub</a>}
    </main>
  );
}
