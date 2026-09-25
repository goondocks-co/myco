import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog';
import { PageLoading } from '../ui/page-loading';
import { formatRelative } from '../../lib/format';
import { settingsRefusalText } from '../../hooks/use-settings';
import { useReleaseProvenance, useReleaseProvenanceActions, type ReleaseProvenanceRow, type ReleaseCheck } from '../../hooks/use-release-provenance';
import { useStatus } from '../../hooks/use-status';
import { checkFailureLabel, LOOKUP_TOKEN_WORDS, lookupToken, RATE_LIMIT_REMEDY } from './release-labels';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50';
const inputClass = 'rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface';
const label = 'flex flex-col gap-1 font-sans text-xs text-on-surface-variant';

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

/** Per-Project release tracking, beside the committed source it describes. */
export function ReleaseTracking({ projectId }: { projectId: string }) {
  const query = useReleaseProvenance(projectId);
  const actions = useReleaseProvenanceActions(projectId);
  const [editing, setEditing] = useState(false);
  const row = query.data?.releaseProvenance ?? null;
  const words = LOOKUP_TOKEN_WORDS[lookupToken(useStatus().data?.target)];
  return <section className="mt-4 border-t border-outline-variant/20 pt-4" aria-label="Release tracking">
    <h3 className="font-sans text-sm font-semibold text-on-surface">Release tracking</h3>
    <p className="mt-1 font-sans text-xs text-on-surface-variant">Answers whether the work behind this Project's memory has shipped, by checking captured commits against GitHub release tags.</p>
    <PageLoading isLoading={query.isPending} error={query.error}>
      {row?.problem && <p role="alert" className="mt-2 font-sans text-xs text-tertiary">The stored release tracking settings cannot be read. No check runs until they are saved again.</p>}
      {row && <div className="mt-2 break-words font-mono text-xs text-on-surface-variant">
        <p>{row.enabled ? 'On' : 'Off'}{row.githubRepo ? ` · ${row.githubRepo}` : ''}</p>
        {row.productionRefs.length > 0 && <p>Releases: {row.productionRefs.join(', ')}</p>}
        {row.integrationRefs.length > 0 && <p>Integration: {row.integrationRefs.join(', ')}</p>}
        {row.packageMap.map((m) => <p key={m.pathGlob}>{m.pathGlob} → {m.tagPattern}</p>)}
        <p data-testid="release-credential">Lookup credential: {row.credential.configured ? 'configured' : words.none} · {row.credential.purpose}</p>
        {row.enabled && <p data-testid="release-check">Last check: {checkSummary(row.check)}</p>}
      </div>}
      <div className="mt-2 flex gap-2">
        <button className={button} type="button" onClick={() => setEditing(true)}>{row?.revision ? 'Edit release tracking' : 'Set up release tracking'}</button>
        {row?.enabled && <button className={button} type="button" disabled={actions.check.isPending} onClick={() => actions.check.mutate()}>Check now</button>}
      </div>
      {actions.check.error && <p role="alert" className="mt-2 font-sans text-xs text-tertiary">{settingsRefusalText(actions.check.error)}</p>}
    </PageLoading>
    <Dialog open={editing} onOpenChange={setEditing}>
      <DialogContent>
        <DialogHeader><DialogTitle>Release tracking</DialogTitle><DialogDescription>Name the GitHub repository and the refs that mean released and merged. {words.dialog}</DialogDescription></DialogHeader>
        {editing && row && <ReleaseTrackingForm projectId={projectId} row={row} placeholder={words.placeholder} onClose={() => setEditing(false)} />}
      </DialogContent>
    </Dialog>
  </section>;
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
  return <form className="flex flex-col gap-3" onSubmit={(event) => {
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
  }}>
    <label className="flex items-center gap-2 font-sans text-sm text-on-surface"><input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />Track releases for this Project</label>
    <label className={label}>GitHub repository (owner/name)<input className={inputClass} value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={row.suggestedRepo ?? 'owner/name'} /></label>
    <label className={label}>Release refs, one per line<textarea className={inputClass} rows={3} value={production} onChange={(e) => setProduction(e.target.value)} placeholder="refs/tags/v*" /></label>
    <label className={label}>Integration branches, one per line<textarea className={inputClass} rows={2} value={integration} onChange={(e) => setIntegration(e.target.value)} placeholder="main" /></label>
    <label className={label}>Monorepo packages, one per line as path = release refs<textarea className={inputClass} rows={3} value={mapping} onChange={(e) => setMapping(e.target.value)} placeholder="packages/app/ = refs/tags/app/v*" /></label>
    <label className={label}>GitHub lookups per check<input className={inputClass} type="number" min={1} max={1000} value={maxLookups} onChange={(e) => setMaxLookups(e.target.value)} /></label>
    <label className="flex items-center gap-2 font-sans text-sm text-on-surface"><input type="checkbox" checked={includeUnknown} onChange={(e) => setIncludeUnknown(e.target.checked)} />Record work whose release cannot be determined as unknown</label>
    <label className={label}>Lookup token — {row.credential.purpose}
      <input className={inputClass} type="password" autoComplete="off" value={token} disabled={removeCredential} onChange={(e) => setToken(e.target.value)}
        placeholder={keepable ? 'Leave blank to keep the configured token' : placeholder} /></label>
    {row.credential.configured && <label className="flex items-center gap-2 font-sans text-sm text-on-surface"><input type="checkbox" checked={removeCredential} onChange={(e) => { setRemoveCredential(e.target.checked); setToken(''); }} />Remove the configured token</label>}
    {actions.save.error && <p role="alert" className="font-sans text-xs text-tertiary">{settingsRefusalText(actions.save.error)}</p>}
    <div className="flex justify-end"><button type="submit" className={primary} disabled={actions.save.isPending}>Save release tracking</button></div>
  </form>;
}
