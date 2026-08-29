import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../components/ui/dialog';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { SubtabPill } from '../components/ui/subtab-pill';
import { AppearanceSection } from '../layout/AppearanceSection';
import { useProjects } from '../hooks/use-projects';
import { needsStepUp, settingsRefusalText, useCapabilities, useSecrets, useSettings, useSettingsActions, type LeafRow, type SecretRow } from '../hooks/use-settings';
import { isArchived } from '../lib/api';
import { formatRelative } from '../lib/format';
import { LEAF_GROUPS, type LeafField } from '../settings/catalogue';

const TABS = [...LEAF_GROUPS.map((g) => ({ id: g.id, label: g.label })), { id: 'secrets', label: 'Credentials' }, { id: 'capabilities', label: 'Project capabilities' }, { id: 'browser', label: 'This browser' }];

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high disabled:opacity-50';
const primary = 'rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90 disabled:opacity-50';
const inputClass = 'rounded-md border border-outline-variant/30 bg-surface-container px-2 py-1 font-sans text-sm text-on-surface';

const CAPABILITY_LABEL: Record<string, string> = { cortex: 'Cortex: digests and instructions', canopy: 'Code map', skills: 'Skills', vault_evolution: 'Memory upkeep' };

/** What a step-up dialog is waiting to do once it has a key. */
type PendingChange = { kind: 'leaf'; leaf: string; label: string; value: unknown } | { kind: 'secret'; name: string; value: string } | { kind: 'delete'; name: string };

export function Settings() {
  const [tab, setTab] = useState(LEAF_GROUPS[0]!.id);
  const [pending, setPending] = useState<PendingChange | null>(null);
  return (
    <PageContainer>
      <PageHeader title="Settings" subtitle="What this server holds for every member. Each change saves as you make it and names who made it." />
      <div className="mb-4">
        <SubtabPill tabs={TABS} activeTab={tab} onTabChange={setTab} />
      </div>
      {LEAF_GROUPS.map((g) => g.id === tab && <LeafGroupPanel key={g.id} groupId={g.id} onStepUp={setPending} />)}
      {tab === 'secrets' && <Secrets onStepUp={setPending} />}
      {tab === 'capabilities' && <ProjectCapabilities />}
      {tab === 'browser' && (
        <Panel title="This browser" eyebrow="Appearance">
          <p className="mb-3 font-sans text-sm text-on-surface-variant">Theme, mode, font and density are kept in this browser only.</p>
          <AppearanceSection />
        </Panel>
      )}
      <StepUpDialog pending={pending} onClose={() => setPending(null)} />
    </PageContainer>
  );
}

function LeafGroupPanel({ groupId, onStepUp }: { groupId: string; onStepUp: (p: PendingChange) => void }) {
  const group = LEAF_GROUPS.find((g) => g.id === groupId)!;
  const settings = useSettings();
  const rows = new Map((settings.data?.leaves ?? []).map((l) => [l.leaf, l]));
  return (
    <PageLoading isLoading={settings.isPending} error={settings.error}>
      <Panel title={group.label} eyebrow="Server">
        <p className="mb-3 font-sans text-sm text-on-surface-variant">{group.note}</p>
        <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label={group.label}>
          {group.leaves.map((f) => <LeafControl key={f.leaf} field={f} row={rows.get(f.leaf)} onStepUp={onStepUp} />)}
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

function LeafControl({ field, row, onStepUp }: { field: LeafField; row: LeafRow | undefined; onStepUp: (p: PendingChange) => void }) {
  const actions = useSettingsActions();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = row?.configured ? row.value : null;
  const shown = draft ?? textOf(field, value);

  const save = (next: unknown) => {
    setError(null);
    if (field.readOnly) return;
    if (row?.requiresStepUp) { onStepUp({ kind: 'leaf', leaf: field.leaf, label: field.label, value: next }); return; }
    actions.setLeaf.mutate({ leaf: field.leaf, value: next }, {
      onError: (err) => (needsStepUp(err) ? onStepUp({ kind: 'leaf', leaf: field.leaf, label: field.label, value: next }) : setError(settingsRefusalText(err, false))),
      onSuccess: () => setDraft(null),
    });
  };
  const commitText = () => {
    if (draft === null) return;
    if (field.kind === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) { setError('Enter a number.'); return; }
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
          {error !== null ? <span className="text-tertiary">{error}</span> : row?.configured ? `Saved · by ${row.updatedBy ?? 'unknown'} ${formatRelative(row.updatedAt)}` : 'Server default'}
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
            <option value="">Server default</option>
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

function Secrets({ onStepUp }: { onStepUp: (p: PendingChange) => void }) {
  const secrets = useSecrets();
  const [editing, setEditing] = useState<SecretRow | null>(null);
  const [draft, setDraft] = useState('');
  const LABEL: Record<string, string> = { anthropic: 'Anthropic', openai: 'OpenAI', openrouter: 'OpenRouter', github: 'GitHub' };
  return (
    <PageLoading isLoading={secrets.isPending} error={secrets.error}>
      <Panel title="Provider credentials" eyebrow="Server">
        <p className="mb-3 font-sans text-sm text-on-surface-variant">Stored once, shown masked, never sent back. Every change needs a step-up key.</p>
        <ul className="flex flex-col divide-y divide-outline-variant/10" aria-label="Credentials">
          {(secrets.data?.secrets ?? []).map((s) => (
            <li key={s.name} className="flex items-center gap-3 py-2 font-sans text-sm">
              <div className="min-w-0 flex-1">
                <div className="text-on-surface">{LABEL[s.name] ?? s.name}</div>
                <div className="font-mono text-xs text-on-surface-variant">{s.configured ? (s.readable ? s.maskedValue : 'stored under a key this server can no longer open — enter it again') : 'not set'}</div>
                {s.configured && <div className="text-xs text-on-surface-variant">updated {formatRelative(s.updatedAt)}{s.updatedBy ? ` by ${s.updatedBy}` : ''}</div>}
              </div>
              <button type="button" className={button} onClick={() => { setDraft(''); setEditing(s); }}>{s.configured ? 'Rotate' : 'Set'}</button>
              {s.configured && <button type="button" className={button} onClick={() => onStepUp({ kind: 'delete', name: s.name })}>Remove</button>}
            </li>
          ))}
        </ul>
      </Panel>
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) { setEditing(null); setDraft(''); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing?.configured ? `Rotate the ${LABEL[editing.name] ?? editing.name} credential` : `Set the ${editing ? LABEL[editing.name] ?? editing.name : ''} credential`}</DialogTitle>
            <DialogDescription>The value is stored and never shown again. You will be asked for a step-up key next.</DialogDescription>
          </DialogHeader>
          <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); if (editing && draft.length > 0) { const name = editing.name; const value = draft; setEditing(null); setDraft(''); onStepUp({ kind: 'secret', name, value }); } }}>
            <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
              Credential
              <input type="password" autoComplete="off" aria-label="Credential value" className={inputClass} value={draft} onChange={(e) => setDraft(e.target.value)} />
            </label>
            <div className="flex justify-end">
              <button type="submit" className={primary} disabled={draft.length === 0}>Continue</button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </PageLoading>
  );
}

/** Asks for the step-up key a change needs, then performs the change once with it. */
function StepUpDialog({ pending, onClose }: { pending: PendingChange | null; onClose: () => void }) {
  const actions = useSettingsActions();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const busy = actions.setLeaf.isPending || actions.setSecret.isPending || actions.deleteSecret.isPending;
  const close = () => { setKey(''); setError(null); onClose(); };
  const title = pending === null ? '' : pending.kind === 'leaf' ? `Change ${pending.label}` : pending.kind === 'secret' ? 'Store the credential' : 'Remove the credential';
  const submit = () => {
    if (pending === null || key === '') return;
    setError(null);
    const opts = { onSuccess: close, onError: (err: unknown) => setError(settingsRefusalText(err, true)) };
    if (pending.kind === 'leaf') actions.setLeaf.mutate({ leaf: pending.leaf, value: pending.value, stepUpKey: key }, opts);
    else if (pending.kind === 'secret') actions.setSecret.mutate({ name: pending.name, value: pending.value, stepUpKey: key }, opts);
    else actions.deleteSecret.mutate({ name: pending.name, stepUpKey: key }, opts);
  };
  return (
    <Dialog open={pending !== null} onOpenChange={(open) => { if (!open) close(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>This change needs a step-up key. Ask whoever runs this server for one; each key works once.</DialogDescription>
        </DialogHeader>
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); submit(); }}>
          <label className="flex flex-col gap-1 font-sans text-xs text-on-surface-variant">
            Step-up key
            <input type="password" autoComplete="off" aria-label="Step-up key" className={inputClass} value={key} onChange={(e) => setKey(e.target.value)} />
          </label>
          {error !== null && <p className="font-sans text-xs text-tertiary">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" className={button} onClick={close}>Cancel</button>
            <button type="submit" className={primary} disabled={key === '' || busy}>{pending?.kind === 'delete' ? 'Remove' : 'Save'}</button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
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
                onClick={() => { setError(null); actions.setCapability.mutate({ projectId, capability, enabled: !enabled }, { onError: (err) => setError(settingsRefusalText(err, false)) }); }}>
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
