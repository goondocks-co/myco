import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Input } from '../ui/input';
import type { BaseFieldControlProps } from './field-control-types';

export interface NumberFieldProps extends BaseFieldControlProps<number> {
  min?: number;
  max?: number;
  step?: number;
  /** Optional unit suffix rendered to the right of the input. */
  suffix?: string;
  placeholder?: string;
}

function clamp(value: number, min: number | undefined, max: number | undefined): number {
  let next = value;
  if (typeof min === 'number') next = Math.max(min, next);
  if (typeof max === 'number') next = Math.min(max, next);
  return next;
}

/**
 * Number input with the draft/clamp/commit pattern. While the user is
 * typing, the value lives as a string in local state. On blur or Enter
 * we parse, clamp to [min, max], and commit. NaN snaps back to the
 * last good value.
 */
export function NumberField({
  id,
  value,
  onChange,
  disabled,
  readonly,
  min,
  max,
  step,
  suffix,
  placeholder,
}: NumberFieldProps) {
  const [draft, setDraft] = useState<string>(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  function commit() {
    // An emptied input is not a zero: Number('') === 0, which would commit
    // a value the user never typed. Treat it like NaN and snap back.
    if (draft.trim() === '') {
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (Number.isNaN(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(parsed, min, max);
    if (next !== value) onChange(next);
    setDraft(String(next));
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(String(value));
    }
  }

  if (readonly) {
    return (
      <div className="flex items-center gap-2">
        <div
          id={id}
          className="flex h-9 w-32 items-center rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 font-mono text-sm text-on-surface"
        >
          {value}
        </div>
        {suffix && (
          <span className="font-sans text-xs text-on-surface-variant">{suffix}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type="number"
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={handleKeyDown}
        className="w-32 font-mono"
      />
      {suffix && (
        <span className="font-sans text-xs text-on-surface-variant">{suffix}</span>
      )}
    </div>
  );
}
