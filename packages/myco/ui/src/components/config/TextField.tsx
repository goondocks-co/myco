import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Input } from '../ui/input';
import type { BaseFieldControlProps } from './field-control-types';

export interface TextFieldProps extends BaseFieldControlProps<string> {
  placeholder?: string;
  /** Trim the draft before committing. Defaults to true. */
  trim?: boolean;
}

/**
 * Plain text input with the same draft/commit-on-blur pattern as
 * NumberField, for consistency in feel across the unified Settings page.
 * Pressing Enter commits; Escape reverts the draft.
 */
export function TextField({
  id,
  value,
  onChange,
  disabled,
  readonly,
  placeholder,
  trim = true,
}: TextFieldProps) {
  const [draft, setDraft] = useState<string>(value);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    const next = trim ? draft.trim() : draft;
    if (next !== value) onChange(next);
    setDraft(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      commit();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      setDraft(value);
    }
  }

  if (readonly) {
    return (
      <div
        id={id}
        className="flex h-9 w-full items-center rounded-md border border-[var(--ghost-border)] bg-surface-container-lowest px-3 font-mono text-sm text-on-surface"
      >
        {value}
      </div>
    );
  }

  return (
    <Input
      id={id}
      type="text"
      value={draft}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={handleKeyDown}
      className="font-mono"
    />
  );
}
