import { useState } from 'react';

export function PatternInput({ label, patterns, readOnly, pending, onSave }: {
  label: string; patterns: readonly string[]; readOnly?: boolean; pending: boolean; onSave: (patterns: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const pattern = draft.trim();
    if (!pattern || patterns.includes(pattern)) return;
    onSave([...patterns, pattern]);
    setDraft('');
  };
  return <div className="flex w-full flex-col gap-2">
    <ul aria-label={label} className="flex flex-wrap gap-1">
      {patterns.map((pattern) => <li key={pattern} className="rounded border border-outline-variant/30 px-2 py-1 font-mono text-xs">
        {pattern}{!readOnly && <button type="button" className="ml-2 text-on-surface-variant" disabled={pending} aria-label={`Remove ${pattern}`} onClick={() => onSave(patterns.filter((item) => item !== pattern))}>×</button>}
      </li>)}
    </ul>
    {!readOnly && <div className="flex gap-2">
      <input aria-label={`Add ${label.toLowerCase()}`} className="min-w-0 flex-1 rounded border border-outline-variant/30 bg-surface-container px-2 py-1 font-mono text-xs" placeholder="e.g. fixtures or **/*.generated.ts" value={draft} disabled={pending} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} />
      <button type="button" className="font-sans text-xs text-primary" disabled={pending || !draft.trim() || patterns.includes(draft.trim())} onClick={add}>Add</button>
    </div>}
  </div>;
}
