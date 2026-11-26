import { useState, type ReactNode } from 'react';
import { ActionLink, Button, Card, Dialog, DialogContent, DialogFooter, Disclosure, ErrorState, FactRow, Input, LoadingState, Switch, Textarea } from '../../../design';
import { ApiError } from '../../../lib/api';
import { checkFailureLabel, shortRef } from '../../../components/release/release-labels';
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

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The latest check in words: when, how many sessions it checked and what changed, and, for the sessions it did not
 * finish, why. Unfinished sessions keep their earlier state and stay pending; lookups running out is told apart from
 * the number of sessions one check takes.
 */
export function checkSummary(check: ReleaseCheck | null): string {
  if (check === null || check.startedAt === null) return check?.requestedAt ? 'Check requested' : 'Not checked yet';
  if (check.finishedAt === null || check.finishedAt < check.startedAt) return `Checking ${sinceWords(check.startedAt, Date.now())}`;
  const c = check.counts;
  const parts: string[] = [];
  if (c !== null) {
    const changed = c.changed === 0 ? 'no release state changed' : `${plural(c.changed, 'release state', 'release states')} changed`;
    const unknown = c.unknown === 0 ? '' : `, and Myco couldn’t tell for ${c.unknown.toLocaleString()}`;
    parts.push(`Checked ${plural(c.checked, 'session', 'sessions')}; ${changed}${unknown}.`);
  }
  const missed = c === null ? 0 : c.unavailable + c.deferred;
  const unfinished = `At least ${plural(missed, 'session', 'sessions')} ${missed === 1 ? 'wasn’t' : 'weren’t'} finished`;
  if (check.failure === 'budget_exhausted') {
    const used = check.lookups === null ? 'all its GitHub lookups' : `all ${check.lookups.toLocaleString()} of its GitHub lookups`;
    parts.push(`${missed > 0 ? unfinished : 'It stopped early'} because this check used ${used}. Unfinished sessions stay pending for later checks, which can run out the same way: to make progress, raise “GitHub lookups per check” under More, or list fewer tags and branches.`);
  } else if (check.failure !== null) {
    parts.push(`${missed > 0 ? unfinished : 'It stopped'} because of this: ${checkFailureLabel(check.failure)}. Unfinished sessions stay pending and keep their earlier state.`);
  } else if (missed > 0) {
    parts.push(`${unfinished}: one check takes a limited number of sessions, and a session that changed while it ran waits. They stay pending for later checks.`);
  }
  const pending = check.requestedAt !== null && check.requestedAt > check.startedAt ? ' Another check is requested.' : '';
  return `${agoWords(check.finishedAt)}: ${parts.join(' ')}${pending}`;
}

/**
 * Release tracking for a project: which of its sessions have shipped, found by
 * looking for each session's last commit in the release tags and merged-into
 * branches of the project's connected repository. A summary of what is set, the latest check, a form to set it up
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
      description="Which of this project’s sessions have shipped. Myco looks for the commit each session ended on in your release tags, and in the branch work is merged into."
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
                {row.productionRefs.length > 0 && <FactRow term="Release tags" mono>{row.productionRefs.map(shortRef).join(', ')}</FactRow>}
                {row.integrationRefs.length > 0 && <FactRow term="Merged into" mono>{row.integrationRefs.map(shortRef).join(', ')}</FactRow>}
                {row.packageMap.length > 0 && (
                  <FactRow term="Packages" mono>
                    {row.packageMap.map((m) => <span key={m.pathGlob} className="block">{`${m.pathGlob} → ${shortRef(m.tagPattern)}`}</span>)}
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
        <DialogContent title={row?.revision ? 'Edit release tracking' : 'Set up release tracking'} description="Myco finds out which sessions have shipped by looking for the commit each one ended on in your release tags and in the branch work is merged into. It reads the repository through this server’s GitHub App.">
          {editing && row !== null && <ReleaseTrackingForm projectId={projectId} row={row} onClose={() => setEditing(false)} />}
        </DialogContent>
      </Dialog>
    </AdminSection>
  );
}

/** What the server said when it refused the settings: its own sentence for a value it could not take. */
function releaseRefusalText(err: unknown): string {
  const reason = err instanceof ApiError && typeof err.body === 'object' && err.body !== null ? Reflect.get(err.body, 'reason') : null;
  return err instanceof ApiError && err.status === 400 && typeof reason === 'string' && reason !== '' ? reason : settingsRefusalText(err);
}

function FormField({ id, label, hint, children }: { id: string; label: string; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-s1">
      <label htmlFor={id} className="t-body font-medium text-ink">{label}</label>
      <p id={`${id}-hint`} className="t-small text-muted">{hint}</p>
      {children}
    </div>
  );
}

function SwitchField({ id, label, hint, checked, onCheckedChange }: { id: string; label: string; hint?: string; checked: boolean; onCheckedChange: (checked: boolean) => void }) {
  return (
    <div className="flex items-start justify-between gap-s3 py-s1">
      <div className="flex min-w-0 flex-col gap-s1">
        <label htmlFor={id} className="t-body text-ink">{label}</label>
        {hint !== undefined && <p className="t-small text-muted">{hint}</p>}
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
    </div>
  );
}

function ReleaseTrackingForm({ projectId, row, onClose }: { projectId: string; row: ReleaseProvenanceRow; onClose: () => void }) {
  const actions = useReleaseProvenanceActions(projectId);
  const branch = row.repository?.branch ?? 'main';
  const [enabled, setEnabled] = useState(row.revision === null ? true : row.enabled);
  const [production, setProduction] = useState(row.productionRefs.join('\n'));
  const [integration, setIntegration] = useState((row.revision === null ? [branch] : row.integrationRefs).join('\n'));
  const [mapping, setMapping] = useState(row.packageMap.map((m) => `${m.pathGlob}${MAPPING_SEPARATOR}${m.tagPattern}`).join('\n'));
  const [maxLookups, setMaxLookups] = useState(String(row.maxLookups));
  const [includeUnknown, setIncludeUnknown] = useState(row.includeUnknown);
  return (
    <form
      className="flex flex-col gap-s4"
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
      <FormField id="release-refs" label="Which tags mark a release?" hint="One per line. A * stands for anything: v* covers v2.1.0 and v2.2.0, and myco/v* covers tags like myco/v2.0.3.">
        <Textarea id="release-refs" aria-describedby="release-refs-hint" className="t-mono" value={production} onChange={(e) => setProduction(e.target.value)} placeholder="v*" />
      </FormField>
      <FormField id="release-integration" label="Which branch is work merged into?" hint={`Each branch’s exact name, one per line; for this repository, usually ${branch}. A session Myco finds merged there, directly or through a merged pull request, but in none of the release tags it checked, shows as “Merged, not released”.`}>
        <Textarea id="release-integration" aria-describedby="release-integration-hint" className="t-mono" rows={2} value={integration} onChange={(e) => setIntegration(e.target.value)} placeholder={branch} />
      </FormField>
      <SwitchField
        id="release-unknown"
        label="Say when Myco can’t tell"
        hint="Myco can’t place a session that ended with uncommitted changes to tracked files, whose last commit wasn’t captured or isn’t on GitHub, or, where packages are listed under More, one whose changed files it couldn’t read or that changed too many to check. On, a check that reaches that answer records “Release unknown”. Off, it records nothing new, and a state the session already shows stays."
        checked={includeUnknown}
        onCheckedChange={setIncludeUnknown}
      />
      <Disclosure summary="More" defaultOpen={row.packageMap.length > 0}>
        <div className="flex flex-col gap-s4 pt-s1">
          <FormField id="release-packages" label="Does this repository release packages separately?" hint="One per line: a folder, then =, then the tags of the package in it. For a session that changed files in listed folders, Myco checks only the lines above that those packages’ patterns match, comparing against each line as written, any of which can show it as released; when none match, or no folder is listed, it checks all of them. Where it finds no release, it looks for a merge into the branch above. For example, with myco/v* above: packages/myco/ = myco/v*">
            <Textarea id="release-packages" aria-describedby="release-packages-hint" className="t-mono" value={mapping} onChange={(e) => setMapping(e.target.value)} placeholder="packages/myco/ = myco/v*" />
          </FormField>
          <FormField id="release-lookups" label="GitHub lookups per check" hint="Each check reads tags and compares commits on GitHub, at most this many times. More checks more sessions at once and uses more of GitHub’s hourly allowance.">
            <Input id="release-lookups" aria-describedby="release-lookups-hint" type="number" min={1} max={1000} value={maxLookups} onChange={(e) => setMaxLookups(e.target.value)} />
          </FormField>
        </div>
      </Disclosure>
      {actions.save.error && <p role="alert" className="t-small text-bad">{releaseRefusalText(actions.save.error)}</p>}
      <DialogFooter>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button type="submit" variant="primary" pending={actions.save.isPending}>Save release tracking</Button>
      </DialogFooter>
    </form>
  );
}
