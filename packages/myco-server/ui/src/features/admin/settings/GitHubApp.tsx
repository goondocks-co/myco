import { useQuery } from '@tanstack/react-query';
import type { GitHubAppStatus } from '@goondocks/myco-shared/github-app';
import { Button, Card, ErrorState, LoadingState } from '../../../design';
import { fetchJson } from '../../../lib/api';
import { live } from '../../../lib/live';
import { settingsRefusalText, useGitHubAccountActions, useGitHubInstallations } from '../../../hooks/use-settings';
import { AdminSection } from '../AdminFrame';

/**
 * The server's GitHub App: whether repository access is set up, and the GitHub accounts whose installations Project
 * repositories may be connected through. Both are asked of GitHub only when an admin checks.
 */
export function GitHubApp() {
  const status = useQuery({ queryKey: ['github-app'], queryFn: ({ signal }) => fetchJson<GitHubAppStatus>('/api/github-app', signal), enabled: false, retry: false, ...live('heavy') });
  const installations = useGitHubInstallations(false);
  const accounts = useGitHubAccountActions();
  const data = status.data;
  const check = () => { void status.refetch(); void installations.refetch(); };
  return <AdminSection id="github-app" title="GitHub App" description="This server’s App signs people in and reads repositories selected in GitHub, for accounts approved here.">
    {status.isFetching && data === undefined ? <LoadingState label="Checking GitHub App" /> : status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : <Card>
      <p>{data?.state === 'ready' ? `Repository access is set up for ${data.app.slug}.`
        : data?.state === 'permissions_missing' ? `App permissions need changes: ${data.missing.join(', ')}.`
        : data?.state === 'unavailable' ? data.reason : data?.state === 'key_absent' ? 'Repository access needs setup: the App private key is absent. Sign-in works independently.' : 'Check whether repository access is set up.'}</p>
      <p>On the server operator’s machine, run:</p>
      <code>myco server github-app --target &lt;local|cloudflare&gt; --url {window.location.origin}</code>
      <p>To replace a lost key, generate a new key in GitHub and run the import again.</p>
      {installations.isSuccess && (
        <div className="flex flex-col gap-s2" data-approved-accounts="">
          <p className="t-small text-muted">{installations.data.accounts.length === 0
            ? 'No GitHub account is approved yet. Approve the account that installed the App when connecting a project’s repository.'
            : 'Repositories can be connected from installations by these accounts:'}</p>
          {installations.data.accounts.map((account) => (
            <div key={account.accountId} className="flex items-center justify-between gap-s3">
              <span className="t-small">{`${account.login} (${account.type === 'Organization' ? 'an organization' : 'a personal account'})`}</span>
              <Button variant="ghost" pending={accounts.withdraw.isPending && accounts.withdraw.variables === account.accountId}
                onClick={() => accounts.withdraw.mutate(account.accountId)}>Remove approval</Button>
            </div>
          ))}
        </div>
      )}
      {installations.isError && <p role="alert" className="t-small text-bad">{settingsRefusalText(installations.error)}</p>}
      <Button onClick={check} disabled={status.isFetching || installations.isFetching}>Check again</Button>
    </Card>}
  </AdminSection>;
}
