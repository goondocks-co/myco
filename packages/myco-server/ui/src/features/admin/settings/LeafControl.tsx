import { useState } from 'react';
import { ArrowDown, ArrowUp, X } from 'lucide-react';
import { HARNESS_CREDENTIALS } from '@goondocks/myco-shared/harness-providers';
import { Button, IconButton, Input, Select, Switch, Textarea } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { harnessLabel } from '../../../lib/harness';
import { ago } from '../../today/words';
import { SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { LeafField } from './catalogue';
import { LEAF_DEFAULTS } from './defaults';
import { isRetired } from './retired';
import { EmbeddingRow } from './EmbeddingFields';
import { ModelRow } from './ModelPicker';
import type { LeafRow } from './wire';

/** The agents a machine can run Myco's work with: the harnesses the server opens a credential for, by the same table. */
export const WORKER_AGENTS: readonly string[] = Object.keys(HARNESS_CREDENTIALS);

/** Why a list of agents cannot be saved, or null: every entry an agent a machine can run, and each once. */
export function agentListRefusal(agents: readonly unknown[]): string | null {
  const unknown = agents.filter((agent) => typeof agent !== 'string' || !WORKER_AGENTS.includes(agent));
  if (unknown.length > 0) return `Not an agent a machine can run: ${unknown.map(String).join(', ')}.`;
  if (new Set(agents).size !== agents.length) return 'Each agent can be listed once.';
  return null;
}

/** A value in the words its row shows: on or off, a number with its unit, an option's label, or none. */
function valueWords(field: LeafField, value: unknown): string {
  if (field.kind === 'toggle') return value === true ? 'on' : 'off';
  if (field.kind === 'agent') return typeof value === 'string' && value !== '' ? harnessLabel(value) : 'none';
  if (field.kind === 'agents' || field.kind === 'patterns') {
    return Array.isArray(value) && value.length > 0 ? value.map((v) => (field.kind === 'agents' ? harnessLabel(String(v)) : String(v))).join(', ') : 'none';
  }
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'object') return Object.keys(value).length === 0 ? 'none' : 'set';
  return `${field.optionLabels?.[String(value)] ?? String(value)}${field.unit !== undefined ? ` ${field.unit}` : ''}`;
}

/** What the server applies while nothing is stored, in the words a row's status line uses. */
export function defaultWords(field: LeafField): string | null {
  const entry = LEAF_DEFAULTS[field.leaf];
  if (entry === undefined) return null;
  return 'value' in entry ? valueWords(field, entry.value) : entry.unset.charAt(0).toLowerCase() + entry.unset.slice(1);
}

/** The short text an empty field shows: the default value itself, or what unset means. */
function emptyText(field: LeafField): string {
  const entry = LEAF_DEFAULTS[field.leaf];
  if (entry === undefined) return 'Not set';
  if ('unset' in entry) return entry.unset;
  return valueWords(field, entry.value) === 'none' ? 'None' : valueWords(field, entry.value).replace(field.unit === undefined ? '' : ` ${field.unit}`, '');
}

/** A leaf's value in its editable text form. */
const textOf = (field: LeafField, value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (field.kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
};

/**
 * Where a value stands: who saved it and when, in words, never an id; or, with
 * nothing stored, the server's default and what it is.
 */
export function savedWords(row: LeafRow | undefined, name: string | null, now: number = Date.now(), defaults: string | null = null): string {
  if (row === undefined || !row.configured) return defaults === null ? 'Server default' : `Server default: ${defaults}`;
  const when = row.updatedAt === null ? null : ago(row.updatedAt, now);
  if (name !== null) return when === null ? `Saved by ${name}` : `Saved by ${name} · ${when}`;
  return when === null ? 'Saved' : `Saved ${when}`;
}

/** The kinds whose control needs the row's width: text a person reads and writes at length. */
const STACKED: ReadonlySet<LeafField['kind']> = new Set(['text', 'textarea', 'json', 'patterns', 'agents']);

/**
 * One setting's row and control. Each change writes that leaf alone: a switch
 * or a pick at once, a typed value when the field is left or Enter is pressed,
 * a document or a long text on Save. A setting nothing reads, or one the viewer
 * may not change, is shown and never offered.
 *
 * Exported so a test can render a field of every kind: the catalogue holds no
 * read-only `select` or `textarea` today.
 */
export function LeafControl({ field, row }: { field: LeafField; row: LeafRow | undefined }) {
  if (field.kind === 'embedding-provider' || field.kind === 'embedding-model' || field.kind === 'embedding-endpoint') return <EmbeddingRow field={field} row={row} />;
  if (field.kind === 'model') return <ModelRow field={field} row={row} textControl={<ValueControl field={{ ...field, kind: 'text' }} row={row} />} />;
  return <ValueControl field={field} row={row} />;
}

/** A setting whose value is written on its own. */
function ValueControl({ field, row }: { field: LeafField; row: LeafRow | undefined }) {
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const retired = isRetired(field, row);
  const locked = field.readOnly === true || retired || !admin;
  const nameOf = useMemberNames();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const entry = LEAF_DEFAULTS[field.leaf];
  const fallback = row?.source === 'default' || row?.source === 'derived' ? row.effectiveValue : entry !== undefined && 'value' in entry ? entry.value : null;
  // A setting kept by Myco shows Myco's own value; any other shows what is stored, else what the server applies.
  const value = field.readOnly === true && fallback !== null ? fallback : row?.configured ? (row.editableValue ?? row.value) : fallback;
  // A field typed into shows only what is stored; with nothing stored it stays empty and shows the default as its hint.
  const shown = draft ?? textOf(field, row?.configured === true || field.readOnly === true ? value : null);
  const id = `leaf-${field.leaf}`;
  const pending = actions.setLeaf.isPending || actions.resetLeaf.isPending;

  const save = (next: unknown) => {
    setError(null);
    if (locked) return;
    actions.setLeaf.mutate({ leaf: field.leaf, value: next }, {
      onError: (err) => setError(settingsRefusalText(err)),
      onSuccess: () => setDraft(null),
    });
  };
  const reset = () => {
    setError(null);
    if (locked) return;
    actions.resetLeaf.mutate({ leaf: field.leaf }, {
      onError: (err) => setError(settingsRefusalText(err)),
      onSuccess: () => setDraft(null),
    });
  };
  const commitText = () => {
    if (draft === null || locked) return;
    if (field.kind === 'number') {
      const n = Number(draft);
      if (draft.trim() === '' || !Number.isFinite(n)) { setError('Enter a number.'); return; }
      if ((field.min !== undefined && n < field.min) || (field.max !== undefined && n > field.max)) {
        setError(`Enter a number${field.min !== undefined ? ` from ${field.min}` : ''}${field.max !== undefined ? ` to ${field.max}` : ''}.`);
        return;
      }
      save(n);
    } else if (field.kind === 'json') {
      try { save(JSON.parse(draft)); } catch { setError('Enter the overrides as an object in braces, keyed by task name.'); }
    } else {
      save(draft);
    }
  };

  const placeholder = emptyText(field);
  let control;
  if (field.kind === 'toggle') {
    control = (
      <Switch id={id} aria-label={field.label} checked={value === true} disabled={pending || locked} onCheckedChange={(checked) => save(checked)} />
    );
  } else if (field.kind === 'select') {
    control = (
      <Select
        id={id}
        label={field.label}
        value={value === null ? '' : String(value)}
        placeholder={placeholder}
        disabled={pending || locked}
        options={(field.options ?? []).map((o) => ({ value: String(o), label: valueWords(field, o) }))}
        onValueChange={(raw) => { const option = (field.options ?? []).find((o) => String(o) === raw); save(option ?? raw); }}
      />
    );
  } else if (field.kind === 'number' || field.kind === 'text') {
    control = (
      <>
        <Input
          id={id}
          aria-label={field.label}
          type={field.kind === 'number' ? 'number' : 'text'}
          inputMode={field.kind === 'number' ? 'decimal' : undefined}
          className={field.kind === 'text' ? 'max-w-measure' : undefined}
          min={field.min}
          max={field.max}
          step={field.step}
          value={shown}
          readOnly={locked}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => { if (e.key === 'Enter') commitText(); }}
        />
        {field.unit !== undefined && <span className="shrink-0 t-small text-muted">{field.unit}</span>}
      </>
    );
  } else if (field.kind === 'textarea' || field.kind === 'json') {
    control = (
      <div className="flex w-full flex-col gap-s2">
        <Textarea
          id={id}
          aria-label={field.label}
          className={field.kind === 'json' ? 't-mono' : undefined}
          rows={Math.min(24, Math.max(6, shown.split('\n').length + 1))}
          value={shown}
          readOnly={locked}
          maxLength={field.maxLength}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
        />
        {row?.retiredValue !== undefined && Object.keys(row.retiredValue).length > 0 && (
          <div data-testid="retired-task-overrides" className="t-small text-muted">
            <p>Retired task preferences (read-only)</p>
            <pre className="t-mono whitespace-pre-wrap break-all">{JSON.stringify(row.retiredValue, null, 2)}</pre>
          </div>
        )}
        {!locked && (
          <Button size="sm" className="self-end" disabled={draft === null} pending={pending && draft !== null} onClick={commitText}>Save</Button>
        )}
      </div>
    );
  } else if (field.kind === 'agent') {
    const stored = typeof value === 'string' ? value : '';
    const options = [
      { value: NO_AGENT, label: 'No preference' },
      ...WORKER_AGENTS.map((agent) => ({ value: agent, label: harnessLabel(agent) })),
      ...(stored !== '' && !WORKER_AGENTS.includes(stored) ? [{ value: stored, label: `${stored} (not an agent a machine can run)` }] : []),
    ];
    control = (
      <Select
        id={id}
        label={field.label}
        value={stored === '' ? NO_AGENT : stored}
        placeholder={placeholder}
        disabled={pending || locked}
        options={options}
        onValueChange={(raw) => save(raw === NO_AGENT ? null : raw)}
      />
    );
  } else if (field.kind === 'agents') {
    control = Array.isArray(value)
      ? <AgentListField label={field.label} agents={value} readOnly={locked} pending={pending} onSave={(next) => {
        const refusal = agentListRefusal(next);
        if (refusal !== null) { setError(refusal); return; }
        save(next);
      }} />
      : <p role="alert" className="t-small text-bad">The stored value must be a list of agents.</p>;
  } else {
    control = Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? <PatternsField label={field.label} patterns={value} readOnly={locked} pending={pending} onSave={save} />
      : <p role="alert" className="t-small text-bad">The stored value must be a list of paths.</p>;
  }

  return (
    <SettingRow
      setting={field.leaf}
      label={field.label}
      htmlFor={field.kind === 'patterns' ? undefined : id}
      note={field.note}
      status={error ?? (retired ? 'Nothing on this server reads it any more.'
        : row?.state === 'invalid' || row?.state === 'not-applicable' ? row.remedy ?? row.reason
        : row?.configured !== true && field.unsetStatus !== undefined ? field.unsetStatus
        // A setting Myco keeps shows its value in full; a status would only repeat it.
        : field.readOnly === true ? undefined
        // An empty field or select already shows the default in words, so the status names it only for a switch.
        : savedWords(row, row?.configured ? nameOf(row.updatedBy) : null, Date.now(), field.resettable && row?.source === 'default'
          ? valueWords(field, row.effectiveValue) : field.kind === 'toggle' || field.resettable ? defaultWords(field) : null))}
      refused={error !== null || row?.state === 'invalid' || row?.state === 'not-applicable'}
      stacked={STACKED.has(field.kind)}
      inline={field.kind === 'toggle'}
      control={field.resettable || row?.repair === 'reset-leaf' ? <div className="flex w-full items-center gap-s2">{control}{row?.configured === true && !locked && <Button size="sm" aria-label={`Reset ${field.label}`} disabled={pending} onClick={reset}>Reset</Button>}</div> : control}
    />
  );
}

/** The option that clears a preferred agent. */
const NO_AGENT = '__none__';

/**
 * Agents in order: each can move up or down or go, and one more is picked
 * below from the agents not yet listed. An entry that names no agent a machine
 * can run says so, and the list saves only once it is gone.
 */
function AgentListField({ label, agents, readOnly, pending, onSave }: {
  label: string; agents: readonly unknown[]; readOnly: boolean; pending: boolean; onSave: (agents: string[]) => void;
}) {
  const listed = agents.map(String);
  const remaining = WORKER_AGENTS.filter((agent) => !listed.includes(agent));
  const move = (from: number, to: number) => {
    const next = [...listed];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    onSave(next);
  };
  return (
    <div className="flex w-full max-w-measure flex-col gap-s3">
      <ol aria-label={label} className="flex flex-col gap-s1">
        {listed.length === 0 && <li className="t-small text-muted">None yet.</li>}
        {listed.map((agent, index) => {
          const known = WORKER_AGENTS.includes(agent);
          return (
            <li key={agent} className="flex min-h-row-tight items-center gap-s2 rounded-control border border-line px-s3" data-agent={agent}>
              <span className="w-s6 shrink-0 t-meta text-faint">{index + 1}</span>
              <span className={known ? 'min-w-0 flex-1 t-body text-ink' : 'min-w-0 flex-1 t-body text-bad'}>
                {known ? harnessLabel(agent) : `${agent} (not an agent a machine can run)`}
              </span>
              {!readOnly && (
                <>
                  <IconButton label={`Move ${harnessLabel(agent)} up`} size="sm" disabled={pending || index === 0} onClick={() => move(index, index - 1)}>
                    <ArrowUp aria-hidden className="size-s4" />
                  </IconButton>
                  <IconButton label={`Move ${harnessLabel(agent)} down`} size="sm" disabled={pending || index === listed.length - 1} onClick={() => move(index, index + 1)}>
                    <ArrowDown aria-hidden className="size-s4" />
                  </IconButton>
                  <IconButton label={`Remove ${harnessLabel(agent)}`} size="sm" disabled={pending} onClick={() => onSave(listed.filter((_, i) => i !== index))}>
                    <X aria-hidden className="size-s4" />
                  </IconButton>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {!readOnly && remaining.length > 0 && (
        <div className="w-full sm:w-select-wide">
          <Select
            label={`Add to ${label.toLowerCase()}`}
            value=""
            placeholder="Add an agent"
            disabled={pending}
            options={remaining.map((agent) => ({ value: agent, label: harnessLabel(agent) }))}
            onValueChange={(agent) => onSave([...listed, agent])}
          />
        </div>
      )}
    </div>
  );
}

/** Paths as a list: each can be removed, and one typed below is added. Read-only, it is the list alone. */
function PatternsField({ label, patterns, readOnly, pending, onSave }: {
  label: string; patterns: readonly string[]; readOnly: boolean; pending: boolean; onSave: (patterns: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const pattern = draft.trim();
  const addable = pattern !== '' && !patterns.includes(pattern);
  const add = () => {
    if (!addable) return;
    onSave([...patterns, pattern]);
    setDraft('');
  };
  return (
    <div className="flex w-full flex-col gap-s3">
      <ul aria-label={label} className="flex flex-wrap gap-s2">
        {patterns.length === 0 && <li className="t-small text-muted">None yet.</li>}
        {patterns.map((item) => (
          <li key={item} className="inline-flex max-w-full items-center gap-s1 rounded-chip bg-surface-3 py-s1 pl-s2 pr-s1 t-mono text-ink-2">
            <span className="min-w-0 break-all">{item}</span>
            {!readOnly && (
              <IconButton label={`Remove ${item}`} size="sm" disabled={pending} onClick={() => onSave(patterns.filter((p) => p !== item))}>
                <X aria-hidden className="size-s4" />
              </IconButton>
            )}
          </li>
        ))}
      </ul>
      {!readOnly && (
        <div className="flex w-full max-w-measure gap-s2">
          <Input
            aria-label={`Add to ${label.toLowerCase()}`}
            className="t-mono"
            placeholder="fixtures or **/*.generated.ts"
            value={draft}
            disabled={pending}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
          />
          <Button disabled={pending || !addable} onClick={add}>Add</Button>
        </div>
      )}
    </div>
  );
}
