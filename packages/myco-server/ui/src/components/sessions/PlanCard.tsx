import { useState } from 'react';
import { Check, ChevronDown, ChevronRight, Copy, X } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Badge } from '../ui/badge';
import { useMembers } from '../../hooks/use-access';
import { PLAN_STATUSES, useSetPlanStatus, type PlanRow, type PlanStatus } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';
import { formatDateTime, formatRelative } from '../../lib/format';
import { TextOrBlob } from './stored-text';

const STATUS_VARIANT: Record<string, 'default' | 'secondary' | 'warning' | 'destructive'> = {
  active: 'default',
  in_progress: 'warning',
  completed: 'secondary',
  abandoned: 'destructive',
};

const STATUS_LABEL: Record<PlanStatus, string> = { active: 'Active', in_progress: 'In progress', completed: 'Completed', abandoned: 'Abandoned' };

/** The checked and total items behind a `checked/total` progress, or null for a plan with no task list. */
export function progressParts(progress: string): { checked: number; total: number } | null {
  const match = /^(\d+)\/(\d+)$/.exec(progress);
  return match === null ? null : { checked: Number(match[1]), total: Number(match[2]) };
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

/** Who last set the plan's status, in the words the reader knows: the member's label, else the id. */
function StatusSetBy({ memberId }: { memberId: string }) {
  const members = useMembers();
  const label = members.data?.members.find((m) => m.id === memberId)?.label ?? memberId;
  return <span>Status set by {label}</span>;
}

/** The status control: writes the plan's status as the signed-in member. A change while one is saving is ignored rather than the control being disabled, so focus stays put. */
function StatusControl({ projectId, sessionId, plan }: { projectId: string; sessionId: string; plan: PlanRow }) {
  const set = useSetPlanStatus(projectId, sessionId);
  return (
    <span className="inline-flex items-center gap-2">
      <select
        aria-label={`Status of ${plan.title ?? plan.planKey}`}
        aria-busy={set.isPending}
        value={plan.status}
        onChange={(e) => { if (!set.isPending) set.mutate({ planKey: plan.planKey, status: e.target.value as PlanStatus }); }}
        className={cn('h-6 rounded-md border border-[var(--ghost-border)] bg-surface-container-low px-1.5 font-sans text-[11px] text-on-surface', set.isPending && 'opacity-60')}
      >
        {PLAN_STATUSES.map((status) => <option key={status} value={status}>{STATUS_LABEL[status]}</option>)}
      </select>
      {set.error && <span className="text-tertiary" role="status">The status could not be saved</span>}
    </span>
  );
}

export interface PlanCardProps {
  projectId: string;
  sessionId: string;
  plan: PlanRow;
  defaultOpen?: boolean;
  /** Rendered under the turn that produced it: the link back to that turn is left out. */
  inTurn?: boolean;
}

/** A captured plan: its status, title, key, timing, who last set its status, the turn it came from, and its task-list progress; open, its markdown. Only the title row toggles, so the controls never sit inside the toggle. */
export function PlanCard({ projectId, sessionId, plan, defaultOpen = false, inTurn = false }: PlanCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  const checklist = progressParts(plan.progress);
  const pct = checklist !== null && checklist.total > 0 ? Math.round((checklist.checked / checklist.total) * 100) : 0;
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
          <StatusControl projectId={projectId} sessionId={sessionId} plan={plan} />
          {plan.updatedBy !== null && <StatusSetBy memberId={plan.updatedBy} />}
          <span title={formatDateTime(plan.createdAt)}>Created {formatRelative(plan.createdAt)}</span>
          {plan.updatedAt !== plan.createdAt && <span title={formatDateTime(plan.updatedAt)}>Updated {formatRelative(plan.updatedAt)}</span>}
          {!inTurn && plan.promptId !== null && (
            <Link to={`?turn=${encodeURIComponent(plan.promptId)}`} className="text-primary underline">From its turn</Link>
          )}
        </div>
        {checklist !== null && checklist.total > 0 && (
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
