import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, X, Eye, EyeOff } from 'lucide-react';

const MIN_REDACTABLE_LENGTH = 16;

/**
 * Renders a slice-based redaction (`first8…last4`) for values long enough
 * that the asterisk run hides more than it shows. Short values fall back
 * to a full mask — the previous formula `${slice(0,8)}${'*'*max(0,len-12)}${slice(-4)}`
 * exposed the entire secret when `len <= 12`, e.g. a 10-char API key
 * `abcdefghij` rendered as `abcdefghghij`. Anything below the cutoff
 * gets `••••••••` instead.
 */
function maskValue(value: string): string {
  if (value.length < MIN_REDACTABLE_LENGTH) {
    return '•'.repeat(Math.max(8, value.length));
  }
  return `${value.slice(0, 8)}${'•'.repeat(value.length - 12)}${value.slice(-4)}`;
}

type CopyState = 'idle' | 'copied' | 'failed';

export function RedactedField({ label, value }: { label: string; value: string }) {
  const [visible, setVisible] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const handleCopy = useCallback(() => {
    clearTimer();
    navigator.clipboard.writeText(value).then(
      () => {
        setCopyState('copied');
        timerRef.current = setTimeout(() => setCopyState('idle'), 2000);
      },
      () => {
        setCopyState('failed');
        timerRef.current = setTimeout(() => setCopyState('idle'), 2000);
      },
    );
  }, [value, clearTimer]);

  const redacted = maskValue(value);

  return (
    <div className="space-y-1">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2 group">
        <span className="text-sm text-on-surface font-mono break-all">
          {visible ? value : redacted}
        </span>
        <button
          type="button"
          onClick={() => setVisible(!visible)}
          className="shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface transition-opacity"
          title={visible ? 'Hide' : 'Reveal'}
        >
          {visible ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
        </button>
        <button
          type="button"
          onClick={handleCopy}
          className="shrink-0 p-1 rounded text-on-surface-variant hover:text-on-surface opacity-0 group-hover:opacity-100 transition-opacity"
          title={copyState === 'failed' ? 'Copy failed — check clipboard permissions' : 'Copy to clipboard'}
          aria-live="polite"
        >
          {copyState === 'copied' && <Check className="h-3.5 w-3.5 text-primary" />}
          {copyState === 'failed' && <X className="h-3.5 w-3.5 text-error" />}
          {copyState === 'idle' && <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
