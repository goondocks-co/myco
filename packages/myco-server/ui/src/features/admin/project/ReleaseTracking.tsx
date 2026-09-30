import { useState, type ReactNode } from 'react';
import { Button, Card, Dialog, DialogContent, DialogFooter, ErrorState, FactRow, Input, LoadingState, Switch, Textarea } from '../../../design';
import { checkFailureLabel, LOOKUP_TOKEN_WORDS, lookupToken, RATE_LIMIT_REMEDY } from '../../../components/release/release-labels';
import { useReleaseProvenance, useReleaseProvenanceActions } from '../../../hooks/use-release-provenance';
import { settingsRefusalText } from '../../../hooks/use-settings';
import { useStatus } from '../../../hooks/use-status';
import { formatRelative } from '../../../lib/format';
import { PROJECT_SETTINGS_ANCHORS } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import type { ReleaseCheck, ReleaseProvenanceRow } from './wire';

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const MAPPING_SEPARATOR = ' = ';

/** The latest check in one line: when, what it concluded, what stopped it, and the remedy when a missing token did. */
export function checkSummary(check: ReleaseCheck | null): string {
  if (check === null || check.startedAt === null) return check?.requestedAt ? 'Check requested' : 'Not checked yet';
  if (check.finishedAt === null || check.finishedAt < check.startedAt) return `Checking since ${formatRelative(check.startedAt)}`;
  const c = check.counts;
  const tally = c ? `${c.checked} checked · ${c.changed} changed · ${c.unknown} unknown · ${c.unavailable + c.deferred} not reached` : '';
  const remedy = check.failure === 'rate_limited_without_credential' ? ` ${RATE_LIMIT_REMEDY}` : '';
  const stopped = check.failure === null ? '' : ` · stopped: ${checkFailureLabel(check.failure)}. Earlier states are kept.${remedy}`;
  const pending = check.requestedAt !== null && check.requestedAt > check.startedAt ? ' · check requested' : '';
  return `${formatRelative(check.finishedAt)} · ${tally}${stopped}${pending}`;
}

/**
 * Release tracking for a project: whether the work behind its memory has
 * shipped, checked against its GitHub release tags. A summary of what is set,
 * the latest check, a form to set it up or edit it, and "Check now". The
 * settings are read again while a requested check runs.
 */
export function ReleaseTracking({ projectId }: { projectId: string }) {
  const query = useReleaseProvenance(projectId);
  const actions = useReleaseProvenanceActions(projectId);
  const [editing, setEditing] = useState(false);
  const row = query.data?.releaseProvenance ?? null;
  const words = LOOKUP_TOKEN_WORDS[lookupToken(useStatus().data?.target)];

  const sectionActions = row === null ? undefined : (
    <>
      {row.enabled && <Button pending={actions.check.isPending} onClick={() => actions.check.mutate()}>Check now</Button>}
      <Button onClick={() => setEditing(true)}>{row.revision ? 'Edit release tracking' : 'Set up release tracking'}</Button>
    </>
  );

  return (
    <AdminSection
      id={PROJECT_SETTINGS_ANCHORS.releases}
      title="Release tracking"
      description="Whether the work behind this project’s memory has shipped, by checking its captured commits against GitHub release tags."
      actions={sectionActions}
    >
      {query.isPending ? <LoadingState label="Loading release tracking" count={2} />
        : query.isError ? <ErrorState error={query.error} onRetry={() => void query.refetch()} />
        : row !== null && (
          <>
            {row.problem !== null && (
              <p role="alert" className="t-small text-bad">The stored release tracking settings cannot be read. No check runs until they are saved again.</p>
            )}
            <Card className="py-s2" data-release-tracking="">
              <dl className="flex flex-col divide-y divide-line">
                <FactRow term="Tracking">{row.enabled ? 'On' : 'Off'}</FactRow>
                {row.githubRepo !== null && <FactRow term="Repository" mono>{row.githubRepo}</FactRow>}
                {row.productionRefs.length > 0 && <FactRow term="Releases" mono>{row.productionRefs.join(', ')}</FactRow>}
                {row.integrationRefs.length > 0 && <FactRow term="Merged into" mono>{row.integrationRefs.join(', ')}</FactRow>}
                {row.packageMap.length > 0 && (
                  <FactRow term="Packages" mono>
                    {row.packageMap.map((m) => <span key={m.pathGlob} className="block">{`${m.pathGlob} → ${m.tagPattern}`}</span>)}
                  </FactRow>
                )}
                <FactRow term="Lookup token">
                  <span data-testid="release-credential">{`${row.credential.configured ? 'Stored' : words.none} · ${row.credential.purpose}`}</span>
                </FactRow>
                {row.enabled && <FactRow term="Last check"><span data-testid="release-check">{checkSummary(row.check)}</span></FactRow>}
              </dl>
            </Card>
            {actions.check.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.check.error)}</p>}
          </>
        )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent title="Release tracking" description={`Name the GitHub repository and the refs that mean released and merged. ${words.dialog}`}>
          {editing && row !== null && <ReleaseTrackingForm projectId={projectId} row={row} placeholder={words.placeholder} onClose={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

function FormField({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-s1">
      <label htmlFor={id} className="t-small text-muted">{label}</label>
      {children}
    </div>
  );
}

function SwitchField({ id, label, checked, onCheckedChange }: { id: string; label: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-s3 py-s1">
      <label htmlFor={id} className="t-body text-ink">{label}</label>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ReleaseTrackingForm({ projectId, row, placeholder, onClose }: { projectId: string; row: ReleaseProvenanceRow; placeholder: string; onClose: () => void }) {
  const actions = useReleaseProvenanceActions(projectId);
  const [enabled, setEnabled] = useState(row.revision === null ? true : row.enabled);
  const [repo, setRepo] = useState(row.githubRepo ?? row.suggestedRepo ?? '');
  const [production, setProduction] = useState(row.productionRefs.join('\n'));
  const [integration, setIntegration] = useState((row.revision === null ? ['main'] : row.integrationRefs).join('\n'));
  const [mapping, setMapping] = useState(row.packageMap.map((m) => `${m.pathGlob}${MAPPING_SEPARATOR}${m.tagPattern}`).join('\n'));
  const [maxLookups, setMaxLookups] = useState(String(row.maxLookups));
  const [includeUnknown, setIncludeUnknown] = useState(row.includeUnknown);
  const [token, setToken] = useState('');
  const [removeCredential, setRemoveCredential] = useState(false);
  const keepable = row.credential.configured && repo === row.githubRepo;
  return (
    <form
      className="flex flex-col gap-s3"
      onSubmit={(event) => {
        event.preventDefault();
        const packageMap = lines(mapping).map((line) => {
          const [pathGlob, tagPattern] = line.split('=').map((part) => part.trim());
          return { pathGlob: pathGlob ?? '', tagPattern: tagPattern ?? '' };
        });
        actions.save.mutate({
          revision: row.revision, enabled, githubRepo: repo.trim() || null, productionRefs: lines(production), integrationRefs: lines(integration),
          packageMap, maxLookups: Number(maxLookups), includeUnknown,
          credential: removeCredential ? null : token ? { token } : undefined,
        }, { onSuccess: () => { setToken(''); actions.save.reset(); onClose(); } });
      }}
    >
      <SwitchField id="release-enabled" label="Track releases for this project" checked={enabled} onCheckedChange={setEnabled} />
      <FormField id="release-repo" label="GitHub repository (owner/name)">
        <Input id="release-repo" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={row.suggestedRepo ?? 'owner/name'} />
      </FormField>
      <FormField id="release-refs" label="Release refs, one per line">
        <Textarea id="release-refs" className="t-mono" value={production} onChange={(e) => setProduction(e.target.value)} placeholder="refs/tags/v*" />
      </FormField>
      <FormField id="release-integration" label="Branches work is merged into, one per line">
        <Textarea id="release-integration" className="t-mono" rows={2} value={integration} onChange={(e) => setIntegration(e.target.value)} placeholder="main" />
      </FormField>
      <FormField id="release-packages" label="Packages in one repository, one per line as path = release refs">
        <Textarea id="release-packages" className="t-mono" value={mapping} onChange={(e) => setMapping(e.target.value)} placeholder="packages/app/ = refs/tags/app/v*" />
      </FormField>
      <FormField id="release-lookups" label="GitHub lookups per check">
        <Input id="release-lookups" type="number" min={1} max={1000} value={maxLookups} onChange={(e) => setMaxLookups(e.target.value)} />
      </FormField>
      <SwitchField id="release-unknown" label="Record work whose release can’t be told as unknown" checked={includeUnknown} onCheckedChange={setIncludeUnknown} />
      <FormField id="release-token" label={`Lookup token — ${row.credential.purpose}`}>
        <Input
          id="release-token"
          type="password"
          autoComplete="off"
          value={token}
          disabled={removeCredential}
          onChange={(e) => setToken(e.target.value)}
          placeholder={keepable ? 'Leave blank to keep the stored token' : placeholder}
        />
      </FormField>
      {row.credential.configured && (
        <SwitchField id="release-remove-token" label="Remove the stored token" checked={removeCredential} onCheckedChange={(checked) => { setRemoveCredential(checked); setToken(''); }} />
      )}
      {actions.save.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.save.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" pending={actions.save.isPending}>Save release tracking</Button>
      </DialogFooter>
    </form>
  );
}
