import { useState } from 'react';
import {
  Button, Card, ConfirmDialog, Dialog, DialogContent, DialogFooter, ErrorState, FactRow, Input, LoadingState, MoreMenu, Switch,
} from '../../../design';
import { settingsRefusalText, useRepository, useRepositoryActions } from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS } from '../../../routes/nav';
import { ago } from '../../today/words';
import { AdminSection } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { RepositoryRow } from './wire';

/** How code tasks reach the repository, in words; never the credential. */
function accessWords(connection: RepositoryRow): string {
  if (connection.credential === null) return 'Public, with no credential';
  return connection.credential.readable ? 'With a read credential' : 'Its read credential can no longer be opened; enter it again';
}

/**
 * The committed source a project's code tasks read: which repository and
 * branch, how it is reached, and who set it. Connecting or editing it is a
 * form; disconnecting is in the section's menu, behind a confirm.
 */
export function Repository({ projectId }: { projectId: string }) {
  const query = useRepository(projectId);
  const actions = useRepositoryActions(projectId);
  const nameOf = useMemberNames();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const connection = query.data?.repository ?? null;
  const closeRemove = () => { setRemoving(false); actions.remove.reset(); };

  const sectionActions = query.isSuccess ? (
    <>
      <Button onClick={() => setEditing(true)}>{connection === null ? 'Connect repository' : 'Edit repository'}</Button>
      {connection !== null && (
        <MoreMenu label="More for the repository" items={[{ label: 'Disconnect repository', tone: 'danger', onSelect: () => setRemoving(true) }]} />
      )}
    </>
  ) : undefined;

  return (
    <AdminSection
      id={PROJECT_SETTINGS_ANCHORS.repository}
      title="Repository"
      description="Code tasks, such as the code map, read a committed snapshot of this repository. A public repository needs no credential."
      actions={sectionActions}
    >
      {query.isPending ? <LoadingState label="Loading the repository" count={2} />
        : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        : connection === null ? <Card><p className="t-body text-muted">No repository connected. Code tasks here need one before they can run.</p></Card>
        : (
          <Card className="py-s2" data-repository="">
            <dl className="flex flex-col divide-y divide-line">
              <FactRow term="Repository" mono>{connection.url}</FactRow>
              <FactRow term="Branch" mono>{connection.branch}</FactRow>
              <FactRow term="Access">{accessWords(connection)}</FactRow>
              <FactRow term="Set">{`${ago(connection.updatedAt, Date.now())}${nameOf(connection.updatedBy) === null ? '' : ` by ${nameOf(connection.updatedBy)}`}`}</FactRow>
            </dl>
          </Card>
        )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent
          title={connection === null ? 'Connect a repository' : 'Edit the repository'}
          description="Choose the repository and branch code tasks should read. For a private repository, give a credential limited to reading it."
        >
          {editing && <RepositoryForm projectId={projectId} connection={connection} onClose={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={removing}
        onOpenChange={(open) => { if (!open) closeRemove(); }}
        title="Disconnect the repository?"
        description="New code tasks need a repository before they can run. The project’s memory stays."
        confirmLabel="Disconnect"
        pending={actions.remove.isPending}
        error={actions.remove.error ? settingsRefusalText(actions.remove.error) : null}
        onConfirm={() => { if (connection !== null) actions.remove.mutate(connection.revision, { onSuccess: closeRemove }); }}
      />
    </AdminSection>
  );
}

function RepositoryForm({ projectId, connection, onClose }: { projectId: string; connection: RepositoryRow | null; onClose: () => void }) {
  const actions = useRepositoryActions(projectId);
  const [url, setUrl] = useState(connection?.url ?? '');
  const [branch, setBranch] = useState(connection?.branch ?? 'main');
  const [username, setUsername] = useState(connection?.username ?? 'x-access-token');
  const [token, setToken] = useState('');
  const [publicAccess, setPublicAccess] = useState(connection?.credential == null);
  const canKeepCredential = connection?.url === url && connection.username === username && connection.credential?.readable === true;
  return (
    <form
      className="flex flex-col gap-s3"
      onSubmit={(event) => {
        event.preventDefault();
        const credential = publicAccess ? null : token ? { username, token } : undefined;
        if (!publicAccess && !token && !canKeepCredential) return;
        actions.save.mutate(
          { url, branch, revision: connection?.revision ?? null, credential },
          { onSuccess: () => { setToken(''); actions.save.reset(); onClose(); } },
        );
      }}
    >
      <label htmlFor="repository-url" className="t-small text-muted">HTTPS repository address</label>
      <Input id="repository-url" type="url" required value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/example/repository.git" />
      <label htmlFor="repository-branch" className="t-small text-muted">Branch</label>
      <Input id="repository-branch" required value={branch} onChange={(e) => setBranch(e.target.value)} />
      <div className="flex items-center justify-between gap-s3 py-s1">
        <label htmlFor="repository-public" className="t-body text-ink">Use without a credential</label>
        <Switch id="repository-public" checked={publicAccess} onCheckedChange={(checked) => { setPublicAccess(checked); setToken(''); }} />
      </div>
      {!publicAccess && (
        <>
          <label htmlFor="repository-username" className="t-small text-muted">Git username</label>
          <Input id="repository-username" required autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)} />
          <label htmlFor="repository-token" className="t-small text-muted">Read token</label>
          <Input
            id="repository-token"
            type="password"
            autoComplete="off"
            required={!canKeepCredential}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={canKeepCredential ? 'Leave blank to keep the current credential' : ''}
          />
        </>
      )}
      {actions.save.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.save.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" pending={actions.save.isPending}>Save repository</Button>
      </DialogFooter>
    </form>
  );
}
