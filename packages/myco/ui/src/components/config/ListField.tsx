import { useState, type ChangeEvent, type ClipboardEvent, type KeyboardEvent } from 'react';
import { X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { BaseFieldControlProps } from './field-control-types';

export interface ListFieldProps extends BaseFieldControlProps {
  value: readonly string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Allow duplicate entries. Defaults to false. */
  allowDuplicates?: boolean;
}

/** Split a pasted block on newlines and commas, trim, drop empties. */
function splitBulkEntries(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * Array of strings rendered as chips with × removers, plus an add input.
 *
 * Append flow:
 * - Enter on the input commits the current draft as a single entry.
 * - Blur on the input commits the current non-empty draft (matches the
 *   textarea behavior of the pre-merge `StringListTextarea`, so users
 *   don't lose a typed entry when they click away).
 * - Pasting a newline- or comma-separated block splits into multiple
 *   entries in one shot (matches `parseStringList` from the old
 *   `release_provenance.production_refs` UI).
 *
 * Duplicates are dropped silently unless `allowDuplicates` is set.
 */
export function ListField({
  id,
  value,
  onChange,
  disabled,
  readonly,
  placeholder,
  allowDuplicates = false,
}: ListFieldProps) {
  const [draft, setDraft] = useState<string>('');

  function appendEntries(entries: string[]) {
    if (entries.length === 0) return;
    const seen = new Set(allowDuplicates ? [] : value);
    const next = value.slice();
    for (const entry of entries) {
      if (!allowDuplicates && seen.has(entry)) continue;
      seen.add(entry);
      next.push(entry);
    }
    if (next.length !== value.length) onChange(next);
  }

  function addEntry() {
    appendEntries(splitBulkEntries(draft));
    setDraft('');
  }

  function removeEntry(index: number) {
    const next = value.slice();
    next.splice(index, 1);
    onChange(next);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter') {
      event.preventDefault();
      addEntry();
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLInputElement>) {
    const pasted = event.clipboardData.getData('text');
    if (!pasted) return;
    if (!/[\r\n,]/.test(pasted)) return; // single token; let default paste handle it
    event.preventDefault();
    const combined = (draft + pasted);
    appendEntries(splitBulkEntries(combined));
    setDraft('');
  }

  return (
    <div className="flex flex-col gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((entry, index) => (
            <Badge
              key={`${entry}-${index}`}
              variant="secondary"
              className="gap-1 pr-1"
            >
              <span className="font-mono">{entry}</span>
              {!readonly && (
                <button
                  type="button"
                  aria-label={`Remove ${entry}`}
                  disabled={disabled}
                  onClick={() => removeEntry(index)}
                  className="rounded-xs p-0.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface disabled:opacity-50"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </Badge>
          ))}
        </div>
      )}
      {!readonly && (
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="text"
            value={draft}
            placeholder={placeholder}
            disabled={disabled}
            onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onBlur={() => {
              if (draft.trim().length > 0) addEntry();
            }}
            className="font-mono"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled || draft.trim().length === 0}
            onClick={addEntry}
          >
            Add
          </Button>
        </div>
      )}
    </div>
  );
}
