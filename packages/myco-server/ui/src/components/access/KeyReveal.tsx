import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/** A secret shown once. It is never fetched again; closing the dialog is the last time it is on screen. */
export function KeyReveal({ label, value, hint }: { label: string; value: string; hint: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <div className="font-sans text-xs uppercase tracking-wide text-on-surface-variant">{label} — shown once</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md bg-surface-container px-3 py-2 font-mono text-xs text-on-surface" data-testid="key-reveal">{value}</code>
        <button type="button" onClick={() => void copy()} aria-label="Copy" className="rounded-md p-2 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface">
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
        </button>
      </div>
      <p className="font-sans text-xs text-on-surface-variant">{hint}</p>
    </div>
  );
}
