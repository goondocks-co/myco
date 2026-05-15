import { useState, type ChangeEvent, type KeyboardEvent } from 'react';
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

/**
 * Array of strings rendered as chips with × removers, plus an add input
 * that appends on Enter or via the Add button. Empty draft is a no-op
 * on add. Duplicates are dropped silently unless allowDuplicates is set.
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

  function addEntry() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (!allowDuplicates && value.includes(trimmed)) {
      setDraft('');
      return;
    }
    onChange([...value, trimmed]);
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
