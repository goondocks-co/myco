import { useCallback, useEffect, useRef, useState } from 'react';
import { Copy, Check, X } from 'lucide-react';

type CopyState = 'idle' | 'copied' | 'failed';

export function CopyableField({ label, value, displayValue, mono = true }: { label: string; value: string; /** Render this instead of `value` (copy still copies `value`) — for masking secrets embedded in an otherwise-pasteable command. */ displayValue?: string; mono?: boolean }) {
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

  return (
    <div className="space-y-1">
      <span className="text-xs text-on-surface-variant">{label}</span>
      <div className="flex items-center gap-2 group">
        <span className={`text-sm text-on-surface break-all ${mono ? 'font-mono' : ''}`}>
          {displayValue ?? value}
        </span>
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
