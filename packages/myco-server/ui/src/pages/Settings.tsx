import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { SubtabPill } from '../components/ui/subtab-pill';
import { AppearanceSection } from '../layout/AppearanceSection';
import { useMembers } from '../hooks/use-access';
import { useProjects } from '../hooks/use-projects';
import { settingsRefusalText, useCapabilities, useSecrets, useSettings, useSettingsActions, type LeafRow, type SecretRow } from '../hooks/use-settings';
import { isArchived } from '../lib/api';
import { formatRelative } from '../lib/format';
import { LEAF_GROUPS, type LeafField } from '../settings/catalogue';

const TABS = [...LEAF_GROUPS.map((g) => ({ id: g.id, label: g.label })), { id: 'secrets', label: 'Credentials' }, { id: 'capabilities', label: 'Project capabilities' }, { id: 'browser', label: 'This browser' }];

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50';
const inputClass = 'rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface';

const CAPABILITY_LABEL: Record<string, string> = { cortex: 'Cortex: digests and instructions', canopy: 'Code map', skills: 'Skills', vault_evolution: 'Memory upkeep' };

/** Who a member id is, in the words the page shows elsewhere. */
function useMemberName(): (id: string | null) => string | null {
  const members = useMembers();
  return (id) => (id === null ? null : members.data?.members.find((m) => m.id === id)?.label ?? id);
}

export function Settings() {
  const [params, setParams] = useSearchParams();
  const requested = params.get('tab');
  const tab = TABS.some((t) => t.id === requested) ? (requested as string) : LEAF_GROUPS[0]!.id;
  const setTab = (id: string) => setParams(id === LEAF_GROUPS[0]!.id ? {} : { tab: id });
  return (
    <PageContainer>
      <PageHeader title="Settings" subtitle="What this server holds for every member. Each change saves as you make it and names who made it." />
      <div className="mb-4">
        <SubtabPill tabs={TABS} activeTab={tab} onTabChange={setTab} />
      </div>
      {LEAF_GROUPS.map((g) => g.id === tab && <LeafGroupPanel key={g.id} groupId={g.id} />)}
      {tab === 'secrets' && <Secrets />}
      {tab === 'capabilities' && <ProjectCapabilities />}
      {tab === 'browser' && (
        <Panel title="This browser" eyebrow="Appearance">
          <p className="mb-3 font-sans text-sm text-on-surface-variant">Theme, mode, font and density are kept in this browser only.</p>
          <AppearanceSection />
        </Panel>
      )}
    </PageContainer>
  );
}

function LeafGroupPanel({ groupId }: { groupId: string }) {
  const group = LEAF_GROUPS.find((g) => g.id === groupId)!;
  const settings = useSettings();
  const rows = new Map((settings.data?.leaves ?? []).map((l) => [l.leaf, l]));
  return (
    <PageLoading isLoading={settings.isPending} error={settings.error}>
      <Panel title={group.label} eyebrow="Server">
        <p className="mb-3 font-sans text-sm text-on-surface-variant">{group.note}</p>
        <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label={group.label}>
          {group.leaves.map((f) => <LeafControl key={f.leaf} field={f} row={rows.get(f.leaf)} />)}
        </ul>
      </Panel>
    </PageLoading>
  );
}

/** A leaf's value in its editable text form. */
const textOf = (field: LeafField, value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (field.kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
};

function LeafControl({ field, row }: { field: LeafField; row: LeafRow | undefined }) {
  const actions = useSettingsActions();
  const nameOf = useMemberName();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = row?.configured ? row.value : null;
  const shown = draft ?? textOf(field, value);

  const save = (next: unknown) => {
    setError(null);
    if (field.readOnly) return;
    actions.setLeaf.mutate({ leaf: field.leaf, value: next }, {
      onError: (err) => setError(settingsRefusalText(err)),
      onSuccess: () => setDraft(null),
    });
  };
  const commitText = () => {
    if (draft === null) return;
    if (field.kind === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) { setError('Enter a number.'); return; }
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) { setError(`Enter a number${field.min !== undefined ? ` from ${field.min}` : ''}${field.max !== undefined ? ` to ${field.max}` : ''}.`); return; }
      save(n);
    } else if (field.kind === 'json') {
      try { save(JSON.parse(draft)); } catch { setError('Enter valid JSON.'); }
    } else {
      save(draft);
    }
  };

  return (
    <li className="flex flex-col gap-1 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 sm:w-1/2">
        <label htmlFor={`leaf-${field.leaf}`} className="font-sans text-sm text-on-surface">{field.label}</label>
        {field.note && <p className="font-sans text-xs text-on-surface-variant">{field.note}</p>}
        <p className="mt-0.5 font-sans text-[11px] text-on-surface-variant" data-testid={`saved-${field.leaf}`}>
          {error !== null ? <span className="text-tertiary">{error}</span> : row?.configured ? `Saved · by ${nameOf(row.updatedBy) ?? 'unknown'} ${formatRelative(row.updatedAt)}` : 'Server default'}
        </p>
      </div>
      <div className="flex items-center gap-2 sm:w-1/2">
        {field.kind === 'toggle' && (
          <button type="button" id={`leaf-${field.leaf}`} role="switch" aria-checked={value === true} aria-label={field.label} disabled={actions.setLeaf.isPending}
            onClick={() => save(value !== true)}
            className={`${button} ${value === true ? 'bg-primary/15 text-primary' : ''}`}>
            {value === true ? 'On' : 'Off'}
          </button>
        )}
        {field.kind === 'select' && (
          <select id={`leaf-${field.leaf}`} aria-label={field.label} className={inputClass} value={value === null ? '' : String(value)} disabled={actions.setLeaf.isPending}
            onChange={(e) => { const raw = e.target.value; if (raw === '') return; const opt = (field.options ?? []).find((o) => String(o) === raw); save(opt ?? raw); }}>
            <option value="" disabled={row?.configured === true}>Server default</option>
            {(field.options ?? []).map((o) => <option key={String(o)} value={String(o)}>{String(o)}{field.unit ? ` ${field.unit}` : ''}</option>)}
          </select>
        )}
        {(field.kind === 'number' || field.kind === 'text') && (
          <input id={`leaf-${field.leaf}`} aria-label={field.label} className={`${inputClass} w-full`} type={field.kind === 'number' ? 'number' : 'text'}
            min={field.min} max={field.max} step={field.step} value={shown} placeholder="Server default"
            onChange={(e) => setDraft(e.target.value)} onBlur={commitText} onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }} />
        )}
        {field.kind === 'json' && (
          <div className="flex w-full flex-col gap-1">
            <textarea id={`leaf-${field.leaf}`} aria-label={field.label} className={`${inputClass} min-h-24 w-full font-mono text-xs`} value={shown} readOnly={field.readOnly}
              placeholder={field.readOnly ? 'Nothing stored' : 'Server default'} onChange={(e) => setDraft(e.target.value)} />
            {!field.readOnly && <button type="button" className={button} disabled={draft === null || actions.setLeaf.isPending} onClick={commitText}>Save</button>}
          </div>
        )}
        {field.unit && field.kind !== 'select' && <span className="font-sans text-xs text-on-surface-variant">{field.unit}</span>}
      </div>
    </li>
  );
}

function Secrets() {
  const secrets = useSecrets();
  const actions = useSettingsActions();
  const nameOf = useMemberName();
  const [editing, setEditing] = useState<SecretRow | null>(null);
  const [removing, setRemoving] = useState<SecretRow | null>(null);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => { setEditing(null); setDraft(''); setError(null); actions.setSecret.reset(); };
  const LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', github: 'GitHub' };
  return (
    <PageLoading isLoading={secrets.isPending} error={secrets.error}>
      <Panel title="Provider credentials" eyebrow="Server">
        <p className="mb-3 font-sans text-sm text-on-surface-variant">Stored once, shown masked, never sent back. Runs bill to whichever account a credential belongs to, and every change names who made it.</p>
        <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Credentials">
          {(secrets.data?.secrets ?? []).map((s) => (
            <li key={s.name} className="flex items-center gap-3 py-2 font-sans text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-on-surface">{LABEL[s.name] ?? s.name}</div>
                <div className="font-mono text-xs text-on-surface-variant">{s.configured ? (s.readable ? s.maskedValue ?? 'set' : 'stored under a key this server can no longer open — enter it again') : 'not set'}</div>
                {s.configured && <div className="text-xs text-on-surface-variant">updated {formatRelative(s.updatedAt)}{s.updatedBy ? ` by ${nameOf(s.updatedBy)}` : ''}</div>}
              </div>
              <button type="button" className={button} onClick={() => { setDraft(''); setEditing(s); }}>{s.configured ? 'Rotate' : 'Set'}</button>
              {s.configured && <button type="button" className={button} onClick={() => setRemoving(s)}>Remove</button>}
            </li>
          ))}
        </ul>
      </Panel>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) close(); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.configured ? `Rotate the ${LABEL[editing.name] ?? editing.name} credential` : `Set the ${editing ? LABEL[editing.name] ?? editing.name : ''} credential`}</DialogTitle>
            <DialogDescription>The value is stored and never shown again. Runs that use this provider bill to the account it belongs to.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (editing && draft.length > 0) { setError(null); actions.setSecret.mutate({ name: editing.name, value: draft }, { onSuccess: close, onError: (err) => setError(settingsRefusalText(err)) }); } }}>
            <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
              Credential
              <input type="password" autoComplete="off" aria-label="Credential value" className={inputClass} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            {error !== null && <p className="font-sans text-xs text-tertiary">{error}</p>}
            <div className="flex justify-end">
              <button type="submit" className={primary} disabled={draft.length === 0 || actions.setSecret.isPending}>Save</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) { setRemoving(null); actions.deleteSecret.reset(); } }}
        title={`Remove the ${removing ? LABEL[removing.name] ?? removing.name : ''} credential?`}
        description="Anything that uses this provider stops working until a new credential is stored."
        confirmLabel="Remove"
        variant="destructive"
        isPending={actions.deleteSecret.isPending}
        errorMessage={actions.deleteSecret.error ? settingsRefusalText(actions.deleteSecret.error) : null}
        onConfirm={() => { if (removing) actions.deleteSecret.mutate({ name: removing.name }, { onSuccess: () => setRemoving(null) }); }}
      />
    </PageLoading>
  );
}

function ProjectCapabilities() {
  const projects = useProjects();
  const live = (projects.data?.projects ?? []).filter((p) => !isArchived(p));
  return (
    <PageLoading isLoading={projects.isPending} error={projects.error}>
      {live.length === 0 ? (
        <Panel title="Project capabilities"><p className="font-sans text-sm text-on-surface-variant">No projects accept capture yet.</p></Panel>
      ) : (
        <div className="flex flex-col gap-4">
          {live.map((p) => <ProjectCapabilityPanel key={p.projectId} projectId={p.projectId} name={p.name} />)}
        </div>
      )}
    </PageLoading>
  );
}

function ProjectCapabilityPanel({ projectId, name }: { projectId: string; name: string }) {
  const caps = useCapabilities(projectId);
  const actions = useSettingsActions();
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel title={name} eyebrow={projectId}>
      <PageLoading isLoading={caps.isPending} error={caps.error}>
        <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label={`${name} capabilities`}>
          {Object.entries(caps.data?.capabilities ?? {}).map(([capability, enabled]) => (
            <li key={capability} className="flex items-center gap-3 py-2 font-sans text-sm">
              <span className="min-w-0 flex-1 text-on-surface">{CAPABILITY_LABEL[capability] ?? capability}</span>
              <button type="button" role="switch" aria-checked={enabled} aria-label={`${CAPABILITY_LABEL[capability] ?? capability} for ${name}`} disabled={actions.setCapability.isPending}
                className={`${button} ${enabled ? 'bg-primary/15 text-primary' : ''}`}
                onClick={() => { setError(null); actions.setCapability.mutate({ projectId, capability, enabled: !enabled }, { onError: (err) => setError(settingsRefusalText(err)) }); }}>
                {enabled ? 'On' : 'Off'}
              </button>
            </li>
          ))}
        </ul>
        {error !== null && <p className="mt-2 font-sans text-xs text-tertiary">{error}</p>}
      </PageLoading>
    </Panel>
  );
}
