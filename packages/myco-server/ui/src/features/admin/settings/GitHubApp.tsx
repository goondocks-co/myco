import { useQuery } from '@tanstack/react-query';
import type { GitHubAppStatus } from '@goondocks/myco-shared/github-app';
import { Button, Card, ErrorState, LoadingState } from '../../../design';
import { fetchJson } from '../../../lib/api';
import { live } from '../../../lib/live';
import { AdminSection } from '../AdminFrame';

export function GitHubApp() {
  const status = useQuery({ queryKey: ['github-app'], queryFn: ({ signal }) => fetchJson<GitHubAppStatus>('/api/github-app', signal), enabled: false, retry: false, ...live('heavy') });
  const data = status.data;
  return <AdminSection id="github-app" title="GitHub App" description="This server’s App signs people in and can read repositories selected in GitHub.">
    {status.isFetching && data === undefined ? <LoadingState label="Checking GitHub App" /> : status.isError ? <ErrorState error={status.error} onRetry={() => void status.refetch()} /> : <Card>
      <p>{data?.state === 'ready' ? `Repository access is set up for ${data.app.slug}.`
        : data?.state === 'permissions_missing' ? `App permissions need changes: ${data.missing.join(', ')}.`
        : data?.state === 'unavailable' ? data.reason : data?.state === 'key_absent' ? 'Repository access needs setup: the App private key is absent. Sign-in works independently.' : 'Check whether repository access is set up.'}</p>
      <p>On the server operator’s machine, run:</p>
      <code>myco server github-app --target &lt;local|cloudflare&gt; --url {window.location.origin}</code>
      <p>To replace a lost key, generate a new key in GitHub and run the import again.</p>
      <Button onClick={() => void status.refetch()} disabled={status.isFetching}>Check again</Button>
    </Card>}
  </AdminSection>;
}
