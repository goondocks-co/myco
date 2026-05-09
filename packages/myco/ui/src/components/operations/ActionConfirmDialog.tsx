import { AlertTriangle } from 'lucide-react';
import { ConfirmDialog } from '../ui/confirm-dialog';
import type { ActionScope } from './scope-helpers';

export interface ActionConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Plain-English action label, e.g. "Reconcile embeddings". */
  action: string;
  /** Resolved scope from the user's pill choice. */
  scope: ActionScope;
  /** Optional cost estimate (e.g. "~12,400 records across 2 Groves"). */
  costEstimate?: string;
  /** Variant — destructive operations get the destructive button styling. */
  variant?: 'destructive';
  onConfirm: () => void;
  isPending?: boolean;
}

function describeScope(scope: ActionScope): string {
  switch (scope.kind) {
    case 'project':
      return 'the active project only';
    case 'grove':
      return 'every project in this Grove';
    case 'all-groves':
      return 'every Grove on this machine';
  }
}

function scopeBadge(scope: ActionScope): string {
  switch (scope.kind) {
    case 'project':
      return 'Project';
    case 'grove':
      return 'Grove';
    case 'all-groves':
      return 'All Groves';
  }
}

export function ActionConfirmDialog({
  open,
  onOpenChange,
  action,
  scope,
  costEstimate,
  variant = 'destructive',
  onConfirm,
  isPending = false,
}: ActionConfirmDialogProps) {
  const description = `${action} will run against ${describeScope(scope)}. ${
    costEstimate ? `Estimated cost: ${costEstimate}.` : ''
  } This cannot be undone automatically.`;

  const meta = [
    { label: 'Scope', value: scopeBadge(scope) },
  ];

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={action}
      description={description.trim()}
      icon={<AlertTriangle className="h-5 w-5 text-tertiary" />}
      meta={meta}
      confirmLabel={action}
      variant={variant}
      onConfirm={onConfirm}
      isPending={isPending}
    />
  );
}

/**
 * Decide whether `(action, scope)` requires explicit user confirmation.
 *
 * Confirmation is required for any destructive action regardless of
 * scope, every all-Groves action, and full re-embed/rebuild against
 * even a single Grove.
 */
export function actionRequiresConfirmation(
  action:
    | 'reconcile'
    | 'reembed-stale'
    | 'rebuild'
    | 'clean-orphans'
    | 'optimize'
    | 'vacuum'
    | 'reindex'
    | 'integrity-check'
    | 'backup',
  scope: ActionScope,
): boolean {
  // Always require confirm for all-groves fan-out.
  if (scope.kind === 'all-groves') return true;
  // Destructive Grove-wide actions.
  if (action === 'rebuild') return true;
  if (action === 'vacuum') return true;
  if (action === 'reindex') return true;
  if (action === 'reembed-stale' && scope.kind === 'grove') return true;
  // All other (project/grove non-destructive) actions go through unprompted.
  return false;
}
