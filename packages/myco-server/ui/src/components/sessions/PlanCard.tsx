import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { type PlanRow } from '../../hooks/use-sessions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { TextOrBlob } from './stored-text';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'warning' | 'destructive'> = {
  active: 'default',
  in_progress: 'warning',
  completed: 'secondary',
  abandoned: 'destructive',
};

/** Checklist progress parsed from `- [x]` and `- [ ]` items in the plan's markdown. */
export function parseChecklist(content: string): { total: number; checked: number } {
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  return { total: checked + unchecked, checked };
}

/** The plan's key, shown and copied: the handle a runtime passes to `myco_plans` to read it. */
function CopyKey({ planKey }: { planKey: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = () => {
    const done = (next: 'copied' | 'failed') => { setState(next); setTimeout(() => setState('idle'), 1500); };
    if (!navigator.clipboard?.writeText) { done('failed'); return; }
    navigator.clipboard.writeText(planKey).then(() => done('copied'), () => done('failed'));
  };
  return (
    <button
      type="button"
      onClick={copy}
      title={state === 'failed' ? 'Copy failed — check clipboard permissions' : `Copy plan key ${planKey}`}
      aria-label={`Copy plan key ${planKey}`}
      aria-live="polite"
      className="inline-flex h-6 items-center gap-1 rounded-md border border-[var(--ghost-border)] px-1.5 font-sans text-[11px] text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
    >
      {state === 'copied' && <Check className="h-3 w-3 text-primary" />}
      {state === 'failed' && <X className="h-3 w-3 text-tertiary" />}
      {state === 'idle' && <Copy className="h-3 w-3" />}
      <span>{state === 'copied' ? 'Copied' : state === 'failed' ? 'Copy failed' : 'Copy key'}</span>
    </button>
  );
}

/** A captured plan: its status, title, key, timing and checklist progress; open, its markdown. Only the title row toggles, so the copy control never sits inside the toggle. */
export function PlanCard({ projectId, plan, defaultOpen = false }: { projectId: string; plan: PlanRow; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const checklist = plan.content !== null ? parseChecklist(plan.content) : null;
  const hasChecklist = checklist !== null && checklist.total > 0;
  const pct = hasChecklist ? Math.round((checklist.checked / checklist.total) * 100) : 0;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--ghost-border)] bg-surface-container-low" data-testid={`plan-${plan.planKey}`}>
      <div className="space-y-1.5 p-4">
        <button type="button" aria-expanded={open} onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 text-left transition-colors hover:text-primary">
          {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />}
          <Badge variant={STATUS_VARIANT[plan.status] ?? 'secondary'} className="shrink-0 text-[10px] uppercase tracking-wide">{plan.status.replace('_', ' ')}</Badge>
          <span className="min-w-0 truncate font-sans text-sm font-medium text-on-surface">{plan.title ?? plan.planKey}</span>
        </button>
        <div className="flex flex-wrap items-center gap-3 pl-5 font-sans text-xs text-on-surface-variant">
          <code className="rounded-xs bg-surface-container-high px-1.5 py-0.5 font-mono text-[11px] text-on-surface">{plan.planKey}</code>
          <CopyKey planKey={plan.planKey} />
          <span title={formatDateTime(plan.createdAt)}>Created {formatRelative(plan.createdAt)}</span>
          {plan.updatedAt !== plan.createdAt && <span title={formatDateTime(plan.updatedAt)}>Updated {formatRelative(plan.updatedAt)}</span>}
        </div>
        {hasChecklist && (
          <div className="space-y-1 pl-5 pt-0.5">
            <div className="flex items-center justify-between font-sans text-xs text-on-surface-variant">
              <span>{checklist.checked}/{checklist.total} items</span>
              <span>{pct}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-surface-container-high">
              <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>
      {open && (
        <div className="border-t border-[var(--ghost-border)] px-4 py-3">
          <TextOrBlob projectId={projectId} text={plan.content} blobKey={plan.blobKey} markdown />
        </div>
      )}
    </div>
  );
}
