import { useState, useCallback } from 'react';
import { Copy, Check, Eye, EyeOff } from 'lucide-react';

export function RedactedField({ label, value }: { label: string; value: string }) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }, [value]);

  const redacted = `${value.slice(0, 8)}${'*'.repeat(Math.max(0, value.length - 12))}${value.slice(-4)}`;

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
          title="Copy to clipboard"
        >
          {copied ? <Check className="h-3.5 w-3.5 text-primary" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
    </div>
  );
}
