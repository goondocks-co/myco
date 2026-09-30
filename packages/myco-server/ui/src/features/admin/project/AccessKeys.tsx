import { useState } from 'react';
import {
  Button, Card, CommandBlock, ConfirmDialog, CopyButton, Dialog, DialogContent, DialogFooter, Disclosure, ErrorState, focusRing, Input, LoadingState, MoreMenu,
} from '../../../design';
import { cn } from '../../../lib/cn';
import { PROJECT_SETTINGS_ANCHORS } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { GrantRow } from '../wire';
import { keyLive, keyName, keyRefusal, keyWords, useGrantActions, useGrants } from './access-keys';

/** A key name the server accepts: 1 to 80 plain printable characters. */
const NAME_PATTERN = '[\\x20-\\x7E]{1,80}';

/** A key the server answered, shown this once with its copy control, and where the agent reaches this server. */
export function KeyOnce({ keyValue }: { keyValue: string }) {
  return (
    <div className="flex flex-col gap-s3">
      <div className="flex flex-col gap-s2">
        <span className="t-kicker text-faint">Access key · shown once</span>
        <div className="flex items-center gap-s2 rounded-control border border-line-strong bg-page py-s1 pl-s3 pr-s1">
          <code tabIndex={0} className={cn('min-w-0 flex-1 break-all rounded-chip py-s1 t-mono text-ink', focusRing)} data-testid="key-once">{keyValue}</code>
          <CopyButton value={keyValue} label="Copy key" />
        </div>
      </div>
      <CommandBlock caption="The agent reaches this server at:" command={`${window.location.origin}/mcp`} />
      <p className="t-small text-muted">Give the agent this address and the key as its bearer token. The key is not shown again; rotate or revoke it here at any time.</p>
    </div>
  );
}

/** One key: its name, its facts, and for a live key the menu that rotates or revokes it. */
function KeyRow({ grant, words, onRotate, onRevoke }: { grant: GrantRow; words: string; onRotate?: () => void; onRevoke?: () => void }) {
  return (
    <div className="flex items-start justify-between gap-s4 px-s4 py-s4" data-access-key={keyLive(grant) ? 'live' : 'ended'}>
      <div className="flex min-w-0 flex-col gap-s1">
        <span className="t-body font-medium text-ink">{keyName(grant)}</span>
        <span className="t-small text-muted">{words}</span>
      </div>
      {onRotate !== undefined && onRevoke !== undefined && (
        <MoreMenu
          label={`More for ${keyName(grant)}`}
          items={[
            { label: 'Rotate key', tone: 'danger', onSelect: onRotate },
            { label: 'Revoke key', tone: 'danger', onSelect: onRevoke },
          ]}
        />
      )}
    </div>
  );
}

/**
 * A project's access keys: an agent outside this server reads this project,
 * and only this project, with one. Adding one shows its key once; rotating
 * shows the new one once; each change that ends a key is confirmed first.
 */
export function AccessKeys({ projectId }: { projectId: string }) {
  const grants = useGrants(projectId);
  const actions = useGrantActions(projectId);
  const nameOf = useMemberNames();
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState<{ title: string; key: string } | null>(null);
  const [rotating, setRotating] = useState<GrantRow | null>(null);
  const [revoking, setRevoking] = useState<GrantRow | null>(null);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);
  const now = Date.now();

  // Closing forgets the key: the page's own state and the mutations that answered it.
  const closeAdd = () => { setAdding(false); setRevealed(null); setLabel(''); setAddError(null); actions.mint.reset(); actions.rotate.reset(); };
  const list = grants.data?.grants ?? [];
  const live = list.filter(keyLive);
  const ended = list.filter((g) => !keyLive(g));

  return (
    <AdminSection
      id={PROJECT_SETTINGS_ANCHORS.accessKeys}
      title="Access keys"
      description="An agent outside this server reads this project, and only this project, with one of these. Every note it leaves is signed with the key’s name."
      actions={<Button variant="primary" onClick={() => { closeAdd(); setAdding(true); }}>Add access key</Button>}
    >
      {grants.isPending ? <LoadingState label="Loading access keys" count={2} />
        : grants.isError ? <ErrorState error={grants.error} onRetry={() => void grants.refetch()} />
        : (
          <>
            {live.length === 0
              ? <Card><p className="t-body text-muted">No agent outside this server can read this project.</p></Card>
              : (
                <RowCard label="Access keys">
                  {live.map((grant) => (
                    <KeyRow
                      key={grant.id}
                      grant={grant}
                      words={keyWords(grant, nameOf, now)}
                      onRotate={() => { setRotateError(null); setRotating(grant); }}
                      onRevoke={() => { setRevokeError(null); setRevoking(grant); }}
                    />
                  ))}
                </RowCard>
              )}
            {ended.length > 0 && (
              <Disclosure summary={`${ended.length} ended ${ended.length === 1 ? 'key' : 'keys'}`}>
                <RowCard label="Ended keys">
                  {ended.map((grant) => <KeyRow key={grant.id} grant={grant} words={keyWords(grant, nameOf, now)} />)}
                </RowCard>
              </Disclosure>
            )}
          </>
        )}

      <Dialog open={adding} onOpenChange={(open) => { if (!open) closeAdd(); }}>
        <DialogContent
          title={revealed?.title ?? 'Add an access key'}
          description={revealed === null ? 'Name the agent, so its notes and its key are recognisable later.' : undefined}
        >
          {revealed !== null ? (
            <>
              <KeyOnce keyValue={revealed.key} />
              <DialogFooter><Button variant="primary" onClick={closeAdd}>Done</Button></DialogFooter>
            </>
          ) : (
            <form
              className="flex flex-col gap-s3"
              onSubmit={(e) => {
                e.preventDefault();
                setAddError(null);
                const name = label.trim();
                actions.mint.mutate(name === '' ? null : name, {
                  onSuccess: (r) => setRevealed({ title: 'Access key ready', key: r.key }),
                  onError: (err) => setAddError(keyRefusal(err)),
                });
              }}
            >
              <label htmlFor="access-key-name" className="t-small text-muted">Name</label>
              <Input
                id="access-key-name"
                value={label}
                maxLength={80}
                pattern={NAME_PATTERN}
                title="Up to 80 plain characters"
                placeholder="review bot"
                onChange={(e) => setLabel(e.target.value)}
              />
              {addError !== null && <p role="alert" className="t-small text-bad">{addError}</p>}
              <DialogFooter>
                <Button variant="ghost" onClick={closeAdd}>Cancel</Button>
                <Button type="submit" variant="primary" pending={actions.mint.isPending}>Create key</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={rotating !== null}
        onOpenChange={(open) => { if (!open) setRotating(null); }}
        title={`Rotate ${rotating === null ? 'this key' : `“${keyName(rotating)}”`}?`}
        description="The current key stops working the moment the new one exists. You see the new key once."
        confirmLabel="Rotate key"
        pending={actions.rotate.isPending}
        error={rotateError}
        onConfirm={() => {
          if (rotating === null) return;
          actions.rotate.mutate(rotating.id, {
            onSuccess: (r) => { setRotating(null); setRevealed({ title: 'New access key', key: r.key }); setAdding(true); },
            onError: (err) => setRotateError(keyRefusal(err)),
          });
        }}
      />

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => { if (!open) setRevoking(null); }}
        title={`Revoke ${revoking === null ? 'this key' : `“${keyName(revoking)}”`}?`}
        description="The agent loses access at once. What it already recorded stays."
        confirmLabel="Revoke key"
        pending={actions.revoke.isPending}
        error={revokeError}
        onConfirm={() => {
          if (revoking === null) return;
          actions.revoke.mutate(revoking.id, { onSuccess: () => setRevoking(null), onError: (err) => setRevokeError(keyRefusal(err)) });
        }}
      />
    </AdminSection>
  );
}
