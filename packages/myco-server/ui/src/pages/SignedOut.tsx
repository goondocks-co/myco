import { buttonVariants } from '../design';

/** Shown when the server answers 401: there is no dashboard session. */
export function SignedOut() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-s4 bg-bg p-gutter text-center">
      <h1 className="t-display text-ink">Sign in to Myco</h1>
      <p className="max-w-measure t-body text-muted">
        This server keeps your projects&rsquo; memory. Sign in with the GitHub account linked to your membership to see it.
      </p>
      <a href="/auth/login" className={buttonVariants({ variant: 'primary' })}>Sign in with GitHub</a>
    </main>
  );
}
