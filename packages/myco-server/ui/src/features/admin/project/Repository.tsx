import { useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import {
  ActionLink, Button, Card, ConfirmDialog, Dialog, DialogContent, DialogFooter, ErrorState, ExternalLink, FactRow, Input, LoadingState, MoreMenu, Select, tapTarget,
} from '../../../design';
import { GITHUB_APP_SETUP_PATH, githubAppPages, installationPage as installationSettings, ownerWords } from '@goondocks/myco-shared/github-app-setup';
import {
  settingsRefusalText, useGitHubAccountActions, useGitHubInstallations, useInstallationRepositories, useRepository, useRepositoryActions,
} from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { InstallationRow, RepositoryRow } from './wire';
import { agoWords } from '@goondocks/myco-shared/time-words';

/** What a Project's repository waits for when this server holds no GitHub App key. */
export const APP_SETUP_WORDS = 'Repository access is not set up on this server yet. Settings → Repositories shows each remaining step.';

/**
 * The committed source a project's code tasks read: one repository this
 * server's GitHub App was installed on, its branch, and who connected it.
 * Connecting is a choice among the App's installations; an installation is
 * offered only once an admin approves the account that installed it.
 */
export function Repository({ projectId }: { projectId: string }) {
  const query = useRepository(projectId);
  const actions = useRepositoryActions(projectId);
  const nameOf = useMemberNames();
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const connection = query.data?.repository ?? null;
  const appConfigured = query.data?.appConfigured ?? true;
  const connectRequested = searchParams.get('connect') === 'repository';
  const closeEditing = () => {
    setEditing(false);
    if (connectRequested) {
      const next = new URLSearchParams(searchParams);
      next.delete('connect');
      navigate({ pathname: location.pathname, search: next.toString(), hash: location.hash }, { replace: true });
    }
  };
  const closeRemove = () => { setRemoving(false); actions.remove.reset(); };
  const open = editing || (connectRequested && query.isSuccess && connection === null && appConfigured);

  const sectionActions = query.isSuccess ? (
    <>
      {appConfigured && <Button onClick={() => setEditing(true)}>{connection === null ? 'Connect repository' : 'Change repository'}</Button>}
      {connection !== null && (
        <MoreMenu label="More for the repository" items={[{ label: 'Disconnect repository', tone: 'danger', onSelect: () => setRemoving(true) }]} />
      )}
    </>
  ) : undefined;

  return (
    <AdminSection
      id={PROJECT_SETTINGS_ANCHORS.repository}
      title="Repository"
      description="Code tasks, such as the code map, read a committed snapshot of this repository through this server’s GitHub App, with read-only access that ends when the snapshot is taken."
      actions={sectionActions}
    >
      {query.isPending ? <LoadingState label="Loading the repository" count={2} />
        : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        : (
          <>
            {!appConfigured && <p role="status" className="t-small text-muted" data-testid="repository-setup">
              {APP_SETUP_WORDS} <ActionLink to={GITHUB_APP_SETUP_PATH}>Open the GitHub App setup →</ActionLink>
            </p>}
            {connection === null ? <Card><p className="t-body text-muted">No repository connected. Code tasks here need one before they can run.</p></Card>
              : (
                <Card className="py-s2" data-repository="">
                  <dl className="flex flex-col divide-y divide-line">
                    <FactRow term="Repository" mono>{connection.url}</FactRow>
                    <FactRow term="Branch" mono>{connection.branch}</FactRow>
                    <FactRow term="Set">{`${agoWords(connection.updatedAt, Date.now())}${nameOf(connection.updatedBy) === null ? '' : ` by ${nameOf(connection.updatedBy)}`}`}</FactRow>
                  </dl>
                </Card>
              )}
          </>
        )}

      <Dialog open={open} onOpenChange={(next) => { if (next) setEditing(true); else closeEditing(); }}>
        <DialogContent
          title={connection === null ? 'Connect a repository' : 'Change the repository'}
          description="Choose a repository the server’s GitHub App was installed on, and the branch code tasks should read."
        >
          {open && <RepositoryForm projectId={projectId} connection={connection} onClose={closeEditing} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing}
        onOpenChange={(next) => { if (!next) closeRemove(); }}
        title="Disconnect the repository?"
        description="New code tasks here, such as the code map and learning from the code, can’t start until a repository is connected again. Everything Myco already learned here stays."
        confirmLabel="Disconnect repository"
        pending={actions.remove.isPending}
        error={actions.remove.error ? settingsRefusalText(actions.remove.error) : null}
        onConfirm={() => { if (connection !== null) actions.remove.mutate(connection.revision, { onSuccess: closeRemove }); }}
      />
    </AdminSection>
  );
}

/** One installation as an admin meets it: chosen, approved, or waiting for an approval it can be given here. */
function InstallationLine({ installation, onApprove, pending }: { installation: InstallationRow; onApprove: () => void; pending: boolean }) {
  const who = ownerWords(installation.account);
  if (!installation.approved) {
    return (
      <div className="flex items-center justify-between gap-s3" data-installation={installation.installationId}>
        <p className="t-small">{`Installed by an account this server has not approved: ${who}${installation.permissionsAccepted ? '' : '; has not accepted the new permissions'}`}</p>
        <Button onClick={onApprove} pending={pending}>Approve</Button>
      </div>
    );
  }
  const unaccepted = installation.permissionsAccepted ? '' : '; has not accepted the new permissions';
  return <p className="t-small text-muted" data-installation={installation.installationId}>{installation.suspended ? `${who}: suspended in GitHub` : `${who}: approved${unaccepted}`}</p>;
}

function RepositoryForm({ projectId, connection, onClose }: { projectId: string; connection: RepositoryRow | null; onClose: () => void }) {
  const actions = useRepositoryActions(projectId);
  const accounts = useGitHubAccountActions();
  const [installationPage, setInstallationPage] = useState(1);
  const installations = useGitHubInstallations(true, installationPage);
  const usable = (installations.data?.installations ?? []).filter((installation) => installation.approved && !installation.suspended);
  const [installationId, setInstallationId] = useState<number | null>(connection?.installationId ?? null);
  const chosenAccount = usable.find((installation) => installation.installationId === installationId) ?? null;
  const chosenInstallation = chosenAccount?.installationId ?? null;
  const [page, setPage] = useState(1);
  const repositories = useInstallationRepositories(chosenInstallation, page);
  const [repositoryId, setRepositoryId] = useState<number | null>(connection?.repositoryId ?? null);
  const [branch, setBranch] = useState(connection?.branch ?? '');
  const choices = repositories.data?.repositories ?? [];
  const chosen = choices.find((repository) => repository.id === repositoryId) ?? null;
  return (
    <form
      className="flex flex-col gap-s3"
      onSubmit={(event) => {
        event.preventDefault();
        if (chosenInstallation === null || repositoryId === null) return;
        actions.save.mutate(
          { installationId: chosenInstallation, repositoryId, branch: branch || chosen?.defaultBranch || 'main', revision: connection?.revision ?? null },
          { onSuccess: () => { actions.save.reset(); onClose(); } },
        );
      }}
    >
      <div className="flex items-center justify-between gap-s3">
        <p className="t-small text-muted">Accounts the App is installed on</p>
        <Button variant="ghost" pending={installations.isFetching} onClick={() => void installations.refetch()}>Refresh GitHub access</Button>
      </div>
      {installations.isPending ? <LoadingState label="Asking GitHub for the App’s installations" count={2} />
        : installations.isError ? <ErrorState error={installations.error} onRetry={() => void installations.refetch()} />
        : installations.data.installations.length === 0
          ? <p className="t-small text-muted" data-no-installation="">The App is not installed on any account yet. Install it on the account that owns the repository, choosing only the repositories code tasks should read, then press Refresh GitHub access.</p>
          : installations.data.installations.map((installation) => (
            <InstallationLine key={installation.installationId} installation={installation}
              pending={accounts.approve.isPending && accounts.approve.variables === installation.installationId}
              onApprove={() => accounts.approve.mutate(installation.installationId)} />
          ))}
      {installations.data?.more && <Button variant="ghost" onClick={() => setInstallationPage(installationPage + 1)}>Show the next accounts</Button>}
      {installationPage > 1 && <Button variant="ghost" onClick={() => setInstallationPage(1)}>Back to the first accounts</Button>}
      {accounts.approve.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(accounts.approve.error)}</p>}
      {installations.isSuccess && (
        <div className="flex flex-col items-start t-small text-muted" data-install-hint="">
          {installations.data.installations.length > 0 && <span>Repository not here? Install the App on the account that owns it, or add the repository to that account’s installation, then press Refresh GitHub access.</span>}
          <ExternalLink className={tapTarget} href={githubAppPages(installations.data.app.slug, installations.data.app.owner).install}>Install the App in GitHub</ExternalLink>
          {chosenAccount !== null && <ExternalLink className={tapTarget} href={installationSettings(chosenAccount.installationId, chosenAccount.account)}>{`Choose ${chosenAccount.account.login}’s repositories in GitHub`}</ExternalLink>}
        </div>
      )}
      {usable.length > 0 && (
        <Select
          id="repository-installation" label="Account" placeholder="Choose an account"
          value={chosenInstallation === null ? '' : String(chosenInstallation)}
          onValueChange={(value) => { setInstallationId(Number(value)); setPage(1); setRepositoryId(null); }}
          options={usable.map((installation) => ({ value: String(installation.installationId), label: installation.account.login }))}
        />
      )}
      {chosenInstallation !== null && (repositories.isPending ? <LoadingState label="Asking GitHub for the repositories this account selected" count={1} />
        : repositories.isError ? <ErrorState error={repositories.error} onRetry={() => void repositories.refetch()} />
        : choices.length === 0 ? <p className="t-small text-muted">This installation includes no repositories. Add one to it in GitHub, then press Refresh GitHub access.</p>
        : (
          <>
            <Select
              id="repository-choice" label="Repository" placeholder="Choose a repository"
              value={repositoryId === null ? '' : String(repositoryId)}
              onValueChange={(value) => { const next = choices.find((repository) => repository.id === Number(value)); setRepositoryId(Number(value)); setBranch(next?.defaultBranch ?? ''); }}
              options={choices.map((repository) => ({ value: String(repository.id), label: repository.fullName }))}
            />
            {repositories.data.more && <Button variant="ghost" onClick={() => setPage(page + 1)}>Show the next repositories</Button>}
          </>
        ))}
      <label htmlFor="repository-branch" className="t-small text-muted">Branch</label>
      <Input id="repository-branch" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder={chosen?.defaultBranch ?? 'main'} />
      {actions.save.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.save.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" disabled={chosenInstallation === null || repositoryId === null} pending={actions.save.isPending}>Save repository</Button>
      </DialogFooter>
    </form>
  );
}
