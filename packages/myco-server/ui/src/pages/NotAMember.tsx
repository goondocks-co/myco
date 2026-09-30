import { INVITE_CONTROLS } from '@goondocks/myco-shared/member-protocol';
import { Link as RouterLink } from 'react-router-dom';
import { Button, buttonVariants } from '../design';
import { readPendingLink } from '../lib/pending-link';
import { signOut } from '../lib/session';

/**
 * Signed in, and no member is linked to this account. A GitHub account reaches
 * the dashboard through a member, and a member exists once a machine joins with
 * an invitation; an admin then connects the account to it. Only a server with
 * no admin yet lets a joined machine link the account itself.
 */
export function NotAMember({ login }: { login: string }) {
  const pending = readPendingLink();
  return (
    <div className="min-h-screen bg-bg text-ink">
      <main className="mx-auto flex w-full max-w-[600px] flex-col gap-s6 p-gutter pt-s12">
        <h1 className="t-display text-ink">{login ? `@${login}` : 'This account'} isn&rsquo;t connected to a member yet</h1>
        <p className="t-body text-ink-2">The dashboard shows a member&rsquo;s projects, and a member joins from a machine. To connect this account:</p>
        <ol className="flex list-decimal flex-col gap-s3 pl-s5 t-body text-ink-2">
          <li>
            <span className="font-medium text-ink">If none of your machines has joined this server,</span> ask an admin for an invitation link, then on your
            machine run <code className="t-mono text-ink">myco login &lt;link&gt;</code>.
          </li>
          <li>
            <span className="font-medium text-ink">Then ask an admin to connect your GitHub account</span> from the {INVITE_CONTROLS.page} page, and open the
            link they send you while signed in as {login ? `@${login}` : 'this account'}.
          </li>
        </ol>
        <p className="t-small text-muted">
          Setting up a new server that has no admin yet? On a machine that has joined it, run <code className="t-mono text-ink-2">myco member link-github</code> and
          open the link it prints.
        </p>
        <div className="flex flex-wrap items-center gap-s3">
          {pending && (
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
