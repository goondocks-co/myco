import { type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from './dialog';
import { Button } from './button';

/** Identity metadata shown in the dialog (e.g., session ID, title). */
export interface ConfirmMeta {
  label: string;
  value: string;
}

/** Impact stat shown in the 2x2 grid. */
export interface ConfirmImpact {
  label: string;
  value: number;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  icon?: ReactNode;
  meta?: ConfirmMeta[];
  impact?: ConfirmImpact[];
  confirmLabel?: string;
  variant?: 'destructive';
  onConfirm: () => void;
  isPending?: boolean;
}

export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  icon,
  meta,
  impact,
  confirmLabel = 'Confirm',
  variant = 'destructive',
  onConfirm,
  isPending = false,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md [&>button:last-child]:hidden">
        <DialogHeader>
          <div className="flex items-center gap-3">
            {icon && (
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-tertiary/15">
                {icon}
              </div>
            )}
            <DialogTitle>{title}</DialogTitle>
          </div>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {/* Identity card — first item as mono badge, second as text */}
        {meta && meta.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-[var(--ghost-border)] bg-surface-container px-4 py-3">
            <span className="font-mono text-xs text-on-surface-variant bg-surface-container-high px-1.5 py-0.5 rounded shrink-0">
              {meta[0]?.value}
            </span>
            {meta.length > 1 && (
              <span className="text-sm font-medium text-on-surface truncate">
                {meta[1]?.value}
              </span>
            )}
          </div>
        )}

        {/* Impact grid */}
        {impact && impact.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {impact.map((item) => (
              <div
                key={item.label}
                className="rounded-md border border-[var(--ghost-border)] bg-surface-container px-3 py-2"
              >
                <div className="font-sans text-[10px] font-medium uppercase tracking-wider text-on-surface-variant">
                  {item.label}
                </div>
                <div className="font-sans text-base font-medium text-on-surface">
                  {item.value}
                </div>
              </div>
            ))}
          </div>
        )}

        <DialogFooter>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant={variant}
            size="sm"
            onClick={onConfirm}
            disabled={isPending}
            className="gap-2"
          >
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
