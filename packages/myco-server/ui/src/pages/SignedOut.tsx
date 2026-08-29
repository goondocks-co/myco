import { PageContainer } from '../components/ui/page-container';

/** Shown when the server answers 401: there is no dashboard session. */
export function SignedOut() {
  return (
    <PageContainer variant="narrow" className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <h1 className="font-serif text-2xl text-on-surface">Sign in to Myco</h1>
      <p className="max-w-md font-sans text-sm text-on-surface-variant">
        This server keeps your projects&rsquo; memory. Sign in with the GitHub account linked to your membership to see it.
      </p>
      <a
        href="/auth/login"
        className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90"
      >
        Sign in with GitHub
      </a>
    </PageContainer>
  );
}
