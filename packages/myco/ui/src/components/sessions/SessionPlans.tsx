import { useState, useMemo, useCallback, useRef, useEffect, type SyntheticEvent } from 'react';
import { Trash2, Copy, Check, X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { MarkdownContent } from '../ui/markdown-content';
import { ConfirmDialog } from '../ui/confirm-dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select';
import { useDeletePlan, useSessionPlans, useUpdatePlanStatus, SessionPlanRow } from '../../hooks/use-sessions';
import { formatEpochAgo, formatEpochAbsolute } from '../../lib/format';

/* ---------- Constants ---------- */

/** Unicode up-arrow for expanded card toggle. */
const ARROW_UP = '▲';

/** Unicode down-arrow for collapsed card toggle. */
const ARROW_DOWN = '▼';

const PLAN_STATUSES = ['active', 'in_progress', 'completed', 'abandoned'] as const;

const PLAN_STATUS_LABELS: Record<(typeof PLAN_STATUSES)[number], string> = {
  active: 'Active',
  in_progress: 'In progress',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

/* ---------- Helpers ---------- */

interface ChecklistProgress {
  total: number;
  checked: number;
}

/** Parse `- [x]` and `- [ ]` checklist items from markdown content. */
function parseChecklist(content: string): ChecklistProgress {
  const checked = (content.match(/- \[x\]/gi) ?? []).length;
  const unchecked = (content.match(/- \[ \]/g) ?? []).length;
  return { total: checked + unchecked, checked };
}

/* ---------- Sub-components ---------- */

const PLAN_STATUS_STYLES: Record<string, string> = {
  active: 'bg-primary/15 text-primary',
  in_progress: 'bg-secondary/15 text-secondary',
  completed: 'bg-surface-container-high text-on-surface-variant',
  abandoned: 'bg-tertiary/15 text-tertiary',
};

const PLAN_STATUS_DEFAULT_STYLE = 'bg-muted text-muted-foreground';

function PlanStatusBadge({ status }: { status: string }) {
  const classes = cn(
    'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide',
    PLAN_STATUS_STYLES[status] ?? PLAN_STATUS_DEFAULT_STYLE,
  );
  return <span className={classes}>{status}</span>;
}

/**
 * Copyable plan ID. Shows and copies the full shareable handle a symbiont
 * passes to `myco_plans` op:"get". Stops propagation so copying never toggles
 * the card.
 */
function CopyablePlanId({ planId }: { planId: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timerRef.current) clearTimeout(timerRef.current); }, []);

  const onCopy = useCallback(() => {
    if (!navigator.clipboard?.writeText) return;
    if (timerRef.current) clearTimeout(timerRef.current);
    navigator.clipboard.writeText(planId).then(
      () => { setState('copied'); timerRef.current = setTimeout(() => setState('idle'), 1500); },
      () => { setState('failed'); timerRef.current = setTimeout(() => setState('idle'), 1500); },
    );
  }, [planId]);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <code className="min-w-0 break-all rounded-xs bg-surface-container-high px-2 py-1 font-mono text-xs text-on-surface">
        {planId}
      </code>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onCopy(); }}
        onKeyDown={(e) => { e.stopPropagation(); }}
        title={state === 'failed' ? 'Copy failed — check clipboard permissions' : `Copy plan ID: ${planId}`}
        className="inline-flex h-7 items-center gap-1 rounded-md border border-[var(--ghost-border)] px-2 font-sans text-xs text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface"
        aria-label={`Copy plan ID ${planId}`}
        aria-live="polite"
      >
        {state === 'copied' && <Check className="h-3 w-3 text-primary" />}
        {state === 'failed' && <X className="h-3 w-3 text-error" />}
        {state === 'idle' && <Copy className="h-3 w-3" />}
        <span>{state === 'copied' ? 'Copied' : 'Copy ID'}</span>
      </button>
    </div>
  );
}

function stopControlPropagation(event: SyntheticEvent): void {
  event.stopPropagation();
}

function planStatusErrorMessage(error: unknown): string | null {
  if (!error) return null;
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'object' && error !== null && 'body' in error) {
    const body = (error as { body?: unknown }).body;
    if (typeof body === 'object' && body !== null && 'error' in body) {
      const inner = (body as { error?: unknown }).error;
      if (typeof inner === 'object' && inner !== null && 'message' in inner) {
        const message = (inner as { message?: unknown }).message;
        if (typeof message === 'string') return message;
      }
    }
  }
  return 'Failed to update plan status.';
}

function isRemoteOwnedStatusError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null && 'status' in error) {
    if ((error as { status?: unknown }).status === 403) return true;
  }
  const message = planStatusErrorMessage(error);
  return message?.toLowerCase().includes('another machine') ?? false;
}

interface PlanCardProps {
  plan: SessionPlanRow;
  initialExpanded?: boolean;
  isDeleting?: boolean;
  isStatusUpdating?: boolean;
  statusReadOnly?: boolean;
  onDelete?: (planId: string) => void;
  onStatusChange?: (planId: string, status: string) => void;
}

function PlanCard({
  plan,
  initialExpanded = false,
  isDeleting = false,
  isStatusUpdating = false,
  statusReadOnly = false,
  onDelete,
  onStatusChange,
}: PlanCardProps) {
  const [expanded, setExpanded] = useState(initialExpanded);

  const checklist = useMemo(
    () => plan.content ? parseChecklist(plan.content) : null,
    [plan.content],
  );
  const hasChecklist = checklist !== null && checklist.total > 0;
  const progressPct = hasChecklist ? Math.round((checklist!.checked / checklist!.total) * 100) : 0;

  const canExpand = Boolean(plan.content);
  const toggleExpanded = () => {
    if (canExpand) setExpanded(v => !v);
  };

  return (
    <div className="rounded-lg border border-border bg-muted/50 overflow-hidden">
      {/* Card header — clicking anywhere toggles expansion */}
      <div
        className={cn(
          'flex items-start gap-3 p-4',
          canExpand && 'cursor-pointer hover:bg-muted/70 transition-colors',
        )}
        onClick={canExpand ? toggleExpanded : undefined}
        onKeyDown={canExpand ? (e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggleExpanded();
          }
        } : undefined}
        role={canExpand ? 'button' : undefined}
        tabIndex={canExpand ? 0 : undefined}
        aria-expanded={canExpand ? expanded : undefined}
      >
        <div className="flex-1 min-w-0 space-y-1.5">
          <div className="flex items-center gap-2 flex-wrap">
            <PlanStatusBadge status={plan.status} />
            {plan.title && (
              <span className="font-sans text-sm font-medium text-on-surface truncate">
                {plan.title}
              </span>
            )}
          </div>

          {plan.source_path && (
            <p className="font-mono text-xs text-muted-foreground truncate" title={plan.source_path}>
              {plan.source_path}
            </p>
          )}

          <div className="flex items-center gap-3 font-sans text-xs text-muted-foreground">
            <CopyablePlanId planId={plan.id} />
            <span>Created {formatEpochAgo(plan.created_at)}</span>
            {plan.updated_at && plan.updated_at !== plan.created_at && (
              <span title={formatEpochAbsolute(plan.updated_at)}>
                Updated {formatEpochAgo(plan.updated_at)}
              </span>
            )}
          </div>

          {/* Checklist progress bar */}
          {hasChecklist && (
            <div className="space-y-1 pt-0.5">
              <div className="flex items-center justify-between font-sans text-xs text-muted-foreground">
                <span>{checklist!.checked}/{checklist!.total} items</span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-1.5 rounded-full bg-border overflow-hidden">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
        </div>

        {/* Action buttons — stopPropagation so they don't trigger header toggle */}
        {(canExpand || onDelete) && (
          <div className="flex shrink-0 items-center gap-2">
            <div
              className="w-36"
              onClick={stopControlPropagation}
              onKeyDown={stopControlPropagation}
            >
              <Select
                value={plan.status}
                disabled={isStatusUpdating || statusReadOnly}
                onValueChange={(status) => {
                  if (status !== plan.status) onStatusChange?.(plan.id, status);
                }}
              >
                <SelectTrigger aria-label="Plan status" className="h-8 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PLAN_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {PLAN_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {onDelete && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  onDelete(plan.id);
                }}
                className="text-xs text-muted-foreground hover:text-destructive transition-colors cursor-pointer disabled:opacity-50"
                disabled={isDeleting}
                aria-label="Delete plan"
              >
                {isDeleting ? 'Deleting...' : 'Delete'}
              </button>
            )}
            {canExpand && (
              <span
                className="mt-0.5 text-xs text-muted-foreground"
                aria-hidden="true"
              >
                {expanded ? ARROW_UP : ARROW_DOWN}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Expanded content */}
      {expanded && plan.content && (
        <div className="border-t border-border px-4 py-3">
          <MarkdownContent content={plan.content} className="text-sm" />
        </div>
      )}
    </div>
  );
}

/* ---------- Component ---------- */

export interface SessionPlansProps {
  sessionId: string;
  expandedPlanId?: string | null;
}

export function SessionPlans({ sessionId, expandedPlanId }: SessionPlansProps) {
  const { data: plans, isLoading, isError } = useSessionPlans(sessionId);
  const deletePlan = useDeletePlan(sessionId);
  const updatePlanStatus = useUpdatePlanStatus(sessionId);
  const [pendingDeletePlan, setPendingDeletePlan] = useState<SessionPlanRow | null>(null);
  const [pendingStatusPlanId, setPendingStatusPlanId] = useState<string | null>(null);
  const [statusError, setStatusError] = useState<{
    planId: string;
    message: string;
    readOnly: boolean;
  } | null>(null);

  async function handleConfirmDelete(): Promise<void> {
    if (!pendingDeletePlan) return;
    try {
      await deletePlan.mutateAsync(pendingDeletePlan.id);
      setPendingDeletePlan(null);
    } catch {
      // Leave dialog open on error; the banner below shows the failure.
      setPendingDeletePlan(null);
    }
  }

  function handleStatusChange(planId: string, status: string): void {
    setPendingStatusPlanId(planId);
    setStatusError(null);
    void updatePlanStatus.mutateAsync({ planId, status })
      .catch((error) => {
        setStatusError({
          planId,
          message: planStatusErrorMessage(error) ?? 'Failed to update plan status.',
          readOnly: isRemoteOwnedStatusError(error),
        });
      })
      .finally(() => setPendingStatusPlanId(null));
  }

  if (isLoading) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="font-sans text-sm text-muted-foreground">Loading plans...</span>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex h-32 items-center justify-center">
        <span className="font-sans text-sm text-muted-foreground">Failed to load plans.</span>
      </div>
    );
  }

  if (!plans || plans.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-lg border border-border bg-muted/30">
        <span className="font-sans text-sm text-muted-foreground">No plans captured for this session</span>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {deletePlan.isError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-sans text-sm text-destructive">
          Failed to delete plan.
        </div>
      )}
      {statusError && (
        <div className="rounded-lg border border-tertiary/30 bg-tertiary/5 px-3 py-2 font-sans text-sm text-tertiary">
          {statusError.readOnly ? `Plan status is read-only: ${statusError.message}` : statusError.message}
        </div>
      )}
      {plans.map(plan => (
        <PlanCard
          key={plan.id}
          plan={plan}
          initialExpanded={plan.status === 'in_progress' || String(plan.id) === expandedPlanId}
          isDeleting={deletePlan.isPending && pendingDeletePlan?.id === plan.id}
          isStatusUpdating={pendingStatusPlanId === plan.id}
          statusReadOnly={statusError?.readOnly === true && statusError.planId === plan.id}
          onDelete={() => setPendingDeletePlan(plan)}
          onStatusChange={handleStatusChange}
        />
      ))}

      <ConfirmDialog
        open={pendingDeletePlan !== null}
        onOpenChange={(open) => { if (!open) setPendingDeletePlan(null); }}
        title="Delete Plan"
        description="This will permanently remove this captured plan from the session."
        icon={<Trash2 className="h-4 w-4 text-tertiary" />}
        meta={pendingDeletePlan ? [
          { label: 'Status', value: pendingDeletePlan.status },
          {
            label: 'Title',
            value: pendingDeletePlan.title || pendingDeletePlan.source_path || pendingDeletePlan.id,
          },
        ] : []}
        confirmLabel="Delete Plan"
        variant="destructive"
        onConfirm={handleConfirmDelete}
        isPending={deletePlan.isPending}
      />
    </div>
  );
}
