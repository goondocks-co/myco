import { ACCOUNT_UNLINKED, OWNER_UNCLAIMED } from '@goondocks/myco-shared/setup-guidance';
import { Link as RouterLink } from 'react-router-dom';
import { Button, buttonVariants } from '../design';
import { readPendingLink } from '../lib/pending-link';
import { signOut } from '../lib/session';

/** Recovery for a signed-in account without active membership in this Deployment. */
export function NotAMember({ login, membership }: { login: string; membership: { state: 'active' | 'inactive' | 'unlinked' | 'unclaimed'; reason: string | null } }) {
  const pending = readPendingLink();
  const inactive = membership.state === 'inactive';
  const unclaimed = membership.state === 'unclaimed';
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="mx-auto flex w-full max-w-narrow flex-col gap-s6 p-gutter pt-s12">
        <h1 className="t-display text-ink">{inactive ? 'Your membership is inactive' : unclaimed ? 'Finish linking the owner' : <>{login ? `@${login}` : 'This account'} isn&rsquo;t connected to a member yet</>}</h1>
        {inactive ? (
          <p className="t-body text-ink-2">{membership.reason ?? 'Ask an administrator to restore your access to this server.'}</p>
        ) : <p className="t-body text-ink-2">{unclaimed ? OWNER_UNCLAIMED : ACCOUNT_UNLINKED}</p>}
        <div className="flex flex-wrap items-center gap-s3">
          {!inactive && pending && (
            <RouterLink to="/link" className={buttonVariants({ variant: 'primary' })}>
              Continue connecting this account
            </RouterLink>
          )}
          <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
        </div>
      </main>
    </div>
  );
}
