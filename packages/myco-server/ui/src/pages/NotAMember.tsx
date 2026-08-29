import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { postJson } from '../lib/api';
import { readPendingLink } from '../lib/pending-link';

async function signOut(): Promise<void> {
  try {
    await postJson('/auth/logout');
  } finally {
    window.location.assign('/');
  }
}

/** Signed in, and no member is linked to this account. */
export function NotAMember({ login }: { login: string }) {
  const pending = readPendingLink();
  return (
    <PageContainer variant="narrow" className="flex min-h-screen flex-col items-center justify-center gap-4 text-center">
      <h1 className="font-serif text-2xl text-on-surface">{login ? `@${login}` : 'This account'} isn&rsquo;t connected to a member yet</h1>
      <p className="max-w-md font-sans text-sm text-on-surface-variant">
        On a machine that has joined this server, run <code className="font-mono">myco member link-github</code> and open the link it prints.
      </p>
      {pending && (
        <Link to="/link" className="rounded-md bg-primary px-4 py-2 font-sans text-sm text-on-primary transition-opacity hover:opacity-90">
          Continue connecting this account
        </Link>
      )}
      <button type="button" onClick={() => void signOut()} className="font-sans text-xs text-on-surface-variant underline-offset-2 hover:underline">
        Sign out
      </button>
    </PageContainer>
  );
}
