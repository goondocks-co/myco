import { useState, type ReactNode } from 'react';
import { ActionLink, Button, Card, Dialog, DialogContent, DialogFooter, ErrorState, FactRow, Input, LoadingState, Switch, Textarea } from '../../../design';
import { checkFailureLabel } from '../../../components/release/release-labels';
import { useReleaseProvenance, useReleaseProvenanceActions } from '../../../hooks/use-release-provenance';
import { settingsRefusalText } from '../../../hooks/use-settings';
import { PROJECT_SETTINGS_ANCHORS, projectRepositoryPath } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import type { ReleaseCheck, ReleaseProvenanceRow } from './wire';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { sinceWords } from '../../today/words';

/** The server reports kept-aside records exactly up to this many. */
const UNRESOLVED_REPORT_CAP = 1000;

const lines = (text: string) => text.split('\n').map((l) => l.trim()).filter(Boolean);
const MAPPING_SEPARATOR = ' = ';

/** The latest check in one line: when, what it concluded, and what stopped it. */
export function checkSummary(check: ReleaseCheck | null): string {
  if (check === null || check.startedAt === null) return check?.requestedAt ? 'Check requested' : 'Not checked yet';
  if (check.finishedAt === null || check.finishedAt < check.startedAt) return `Checking ${sinceWords(check.startedAt, Date.now())}`;
  const c = check.counts;
  const tally = c ? `${c.checked} checked · ${c.changed} changed · ${c.unknown} unknown · ${c.unavailable + c.deferred} not reached` : '';
  const stopped = check.failure === null ? '' : ` · stopped: ${checkFailureLabel(check.failure)}. Earlier states are kept.`;
  const pending = check.requestedAt !== null && check.requestedAt > check.startedAt ? ' · check requested' : '';
  return `${agoWords(check.finishedAt)} · ${tally}${stopped}${pending}`;
}

/**
 * Release tracking for a project: whether the work behind its memory has
 * shipped, checked against the release tags of the project's connected
 * repository. A summary of what is set, the latest check, a form to set it up
 * or edit it, and "Check now". The settings are read again while a requested
 * check runs.
 */
export function ReleaseTracking({ projectId }: { projectId: string }) {
  const query = useReleaseProvenance(projectId);
  const actions = useReleaseProvenanceActions(projectId);
  const [editing, setEditing] = useState(false);
  const row = query.data?.releaseProvenance ?? null;

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
            {row.building && (
              <p className="t-small text-muted" data-testid="release-building">
                Release history is still being prepared after an update. Checks start once it finishes; until then nothing is shown as released or not released that was not before.
              </p>
            )}
            <Card className="py-s2" data-release-tracking="">
              <dl className="flex flex-col divide-y divide-line">
                <FactRow term="Tracking">{row.enabled ? 'On' : 'Off'}</FactRow>
                <FactRow term="Repository">
                  {row.repository === null
                    ? <ActionLink to={projectRepositoryPath(projectId, true)}>Connect a repository to check releases</ActionLink>
                    : <span className="t-mono" data-testid="release-repository">{row.repository.url}</span>}
                </FactRow>
                {row.productionRefs.length > 0 && <FactRow term="Releases" mono>{row.productionRefs.join(', ')}</FactRow>}
                {row.integrationRefs.length > 0 && <FactRow term="Merged into" mono>{row.integrationRefs.join(', ')}</FactRow>}
                {row.packageMap.length > 0 && (
                  <FactRow term="Packages" mono>
                    {row.packageMap.map((m) => <span key={m.pathGlob} className="block">{`${m.pathGlob} → ${m.tagPattern}`}</span>)}
                  </FactRow>
                )}
                {row.enabled && <FactRow term="Last check"><span data-testid="release-check">{checkSummary(row.check)}</span></FactRow>}
                {row.unresolvedStates > 0 && (
                  <FactRow term="Kept aside">
                    <span data-testid="release-unresolved">
                      {`${row.unresolvedStates >= UNRESOLVED_REPORT_CAP ? `At least ${UNRESOLVED_REPORT_CAP}` : row.unresolvedStates} older release record${row.unresolvedStates === 1 ? '' : 's'} could not be matched to one record and ${row.unresolvedStates === 1 ? 'was' : 'were'} kept as found`}
                    </span>
                  </FactRow>
                )}
              </dl>
            </Card>
            {actions.check.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.check.error)}</p>}
          </>
        )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent title="Release tracking" description="Name the refs of the connected repository that mean released and merged. Checks read it through this server’s GitHub App.">
          {editing && row !== null && <ReleaseTrackingForm projectId={projectId} row={row} onClose={() => setEditing(false)} />}
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

function ReleaseTrackingForm({ projectId, row, onClose }: { projectId: string; row: ReleaseProvenanceRow; onClose: () => void }) {
  const actions = useReleaseProvenanceActions(projectId);
  const [enabled, setEnabled] = useState(row.revision === null ? true : row.enabled);
  const [production, setProduction] = useState(row.productionRefs.join('\n'));
  const [integration, setIntegration] = useState((row.revision === null ? ['main'] : row.integrationRefs).join('\n'));
  const [mapping, setMapping] = useState(row.packageMap.map((m) => `${m.pathGlob}${MAPPING_SEPARATOR}${m.tagPattern}`).join('\n'));
  const [maxLookups, setMaxLookups] = useState(String(row.maxLookups));
  const [includeUnknown, setIncludeUnknown] = useState(row.includeUnknown);
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
          revision: row.revision, enabled, productionRefs: lines(production), integrationRefs: lines(integration),
          packageMap, maxLookups: Number(maxLookups), includeUnknown,
        }, { onSuccess: () => { actions.save.reset(); onClose(); } });
      }}
    >
      <SwitchField id="release-enabled" label="Track releases for this project" checked={enabled} onCheckedChange={setEnabled} />
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
      {actions.save.error && <p role="alert" className="t-small text-bad">{settingsRefusalText(actions.save.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" pending={actions.save.isPending}>Save release tracking</Button>
      </DialogFooter>
    </form>
  );
}
