import { useEffect, useState, type ChangeEvent, type KeyboardEvent } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import type { BaseFieldControlProps } from './field-control-types';

export interface SecretFieldProps extends BaseFieldControlProps<string> {
  /** Whether a value is currently configured (e.g., loaded from keychain). */
  configured?: boolean;
  /** Source label, e.g. "keychain" or "env" — surfaced as a chip when configured. */
  source?: string;
  placeholder?: string;
}

/**
 * Masked secret input with a reveal-eye toggle and an optional
 * "stored in keychain" chip. Keychain bridging stays out of this
 * primitive — the consuming page calls the secrets hook and passes
 * `configured` / `source` here.
 */
export function SecretField({
  id,
  value,
  onChange,
  disabled,
  readonly,
  configured,
  source,
  placeholder,
}: SecretFieldProps) {
  const [draft, setDraft] = useState<string>(value);
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  function commit() {
    if (draft !== value) onChange(draft);
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

  const chipLabel = source ? `stored in ${source}` : 'stored in keychain';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Input
          id={id}
          type={revealed ? 'text' : 'password'}
          value={draft}
          placeholder={placeholder}
          disabled={disabled || readonly}
          readOnly={readonly}
          autoComplete="off"
          onChange={(event: ChangeEvent<HTMLInputElement>) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={handleKeyDown}
          className="font-mono"
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label={revealed ? 'Hide secret' : 'Reveal secret'}
          aria-pressed={revealed}
          disabled={disabled}
          onClick={() => setRevealed((prev) => !prev)}
        >
          {revealed ? (
            <EyeOff className="h-4 w-4" />
          ) : (
            <Eye className="h-4 w-4" />
          )}
        </Button>
      </div>
      {configured && (
        <div>
          <Badge variant="default" className="bg-primary/15 text-primary">
            {chipLabel}
          </Badge>
        </div>
      )}
    </div>
  );
}
