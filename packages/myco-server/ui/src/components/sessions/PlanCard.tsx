import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Badge } from '../ui/badge';
import { type PlanRow } from '../../hooks/use-sessions';
import { formatDateTime, formatRelative } from '../../lib/format';
import { cn } from '../../lib/cn';
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

function CopyKey({ planKey }: { planKey: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); void navigator.clipboard?.writeText(planKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
      title={`Copy plan key ${planKey}`}
      aria-label={`Copy plan key ${planKey}`}
      className="inline-flex h-6 items-center gap-1 rounded-md border border-[var(--ghost-border)] px-1.5 font-sans text-[11px] text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
    >
      {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      <span>{copied ? 'Copied' : 'Copy key'}</span>
    </button>
  );
}

/** A captured plan: its status, title, key, timing and checklist progress; open, its markdown. */
export function PlanCard({ projectId, plan, defaultOpen = false }: { projectId: string; plan: PlanRow; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const checklist = plan.content !== null ? parseChecklist(plan.content) : null;
  const hasChecklist = checklist !== null && checklist.total > 0;
  const pct = hasChecklist ? Math.round((checklist.checked / checklist.total) * 100) : 0;
  return (
    <div className="overflow-hidden rounded-lg border border-[var(--ghost-border)] bg-surface-container-low" data-testid={`plan-${plan.planKey}`}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen((v) => !v); } }}
        className="flex cursor-pointer items-start gap-3 p-4 transition-colors hover:bg-surface-container/40"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={STATUS_VARIANT[plan.status] ?? 'secondary'} className="uppercase tracking-wide text-[10px]">{plan.status.replace('_', ' ')}</Badge>
            <span className="truncate font-sans text-sm font-medium text-on-surface">{plan.title ?? plan.planKey}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 font-sans text-xs text-on-surface-variant">
            <code className="rounded-xs bg-surface-container-high px-1.5 py-0.5 font-mono text-[11px] text-on-surface">{plan.planKey}</code>
            <CopyKey planKey={plan.planKey} />
            <span title={formatDateTime(plan.createdAt)}>Created {formatRelative(plan.createdAt)}</span>
            {plan.updatedAt !== plan.createdAt && <span title={formatDateTime(plan.updatedAt)}>Updated {formatRelative(plan.updatedAt)}</span>}
          </div>
          {hasChecklist && (
            <div className="space-y-1 pt-0.5">
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
        <span className={cn('mt-0.5 text-xs text-on-surface-variant')} aria-hidden="true">{open ? '▲' : '▼'}</span>
      </div>
      {open && (
        <div className="border-t border-[var(--ghost-border)] px-4 py-3">
          <TextOrBlob projectId={projectId} text={plan.content} blobKey={plan.blobKey} markdown />
        </div>
      )}
    </div>
  );
}
