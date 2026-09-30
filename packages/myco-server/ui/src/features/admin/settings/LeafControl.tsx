import { useState } from 'react';
import { X } from 'lucide-react';
import { Button, IconButton, Input, Select, Switch, Textarea } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { ago } from '../../today/words';
import { SettingRow } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { LeafField } from './catalogue';
import type { LeafRow } from './wire';

/** A leaf's value in its editable text form. */
const textOf = (field: LeafField, value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (field.kind === 'json') return JSON.stringify(value, null, 2);
  return String(value);
};

/** Where a stored value stands: who saved it and when, in words; never an id. */
export function savedWords(row: LeafRow | undefined, name: string | null, now: number = Date.now()): string {
  if (row === undefined || !row.configured) return 'Server default';
  const when = row.updatedAt === null ? null : ago(row.updatedAt, now);
  if (name !== null) return when === null ? `Saved by ${name}` : `Saved by ${name} · ${when}`;
  return when === null ? 'Saved' : `Saved ${when}`;
}

/** The kinds whose control needs the row's width: text a person reads and writes at length. */
const STACKED: ReadonlySet<LeafField['kind']> = new Set(['text', 'textarea', 'json', 'patterns']);

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
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const locked = field.readOnly === true || !admin;
  const nameOf = useMemberNames();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const value = field.readOnly && field.defaultValue !== undefined ? field.defaultValue : row?.configured ? row.value : field.defaultValue ?? null;
  const shown = draft ?? textOf(field, value);
  const id = `leaf-${field.leaf}`;
  const pending = actions.setLeaf.isPending;

  const save = (next: unknown) => {
    setError(null);
    if (locked) return;
    actions.setLeaf.mutate({ leaf: field.leaf, value: next }, {
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
      try { save(JSON.parse(draft)); } catch { setError('Enter valid JSON.'); }
    } else {
      save(draft);
    }
  };

  const placeholder = field.readOnly === true ? 'Nothing stored' : 'Server default';
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
        placeholder="Server default"
        disabled={pending || locked}
        options={(field.options ?? []).map((o) => ({ value: String(o), label: `${String(o)}${field.unit ? ` ${field.unit}` : ''}` }))}
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
          rows={field.kind === 'json' ? 4 : 6}
          value={shown}
          readOnly={locked}
          maxLength={field.maxLength}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
        />
        {!locked && (
          <Button size="sm" className="self-end" disabled={draft === null} pending={pending && draft !== null} onClick={commitText}>Save</Button>
        )}
      </div>
    );
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
      status={error ?? savedWords(row, row?.configured ? nameOf(row.updatedBy) : null)}
      refused={error !== null}
      stacked={STACKED.has(field.kind)}
      control={control}
    />
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
