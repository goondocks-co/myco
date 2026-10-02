import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type HTMLAttributes, type ReactNode } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { Button } from './Button';

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'title'> {
  /** The dialog's heading, which also names it for assistive technology. */
  title: ReactNode;
  /** One line under the title saying what the dialog is for. */
  description?: ReactNode;
  /** Hides the corner close button, for a dialog whose footer carries the only way out. */
  hideClose?: boolean;
}

/** A centred dialog over a scrim. Radix traps focus inside it and returns focus to the trigger on close. */
export const DialogContent = forwardRef<ElementRef<typeof DialogPrimitive.Content>, DialogContentProps>(
  ({ className, title, description, hideClose = false, children, ...props }, ref) => (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-scrim" />
      <DialogPrimitive.Content
        ref={ref}
        {...(description == null ? { 'aria-describedby': undefined } : {})}
        className={cn(
          'fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-var(--s-12))] w-[calc(100vw-var(--s-8))] max-w-[480px] -translate-x-1/2 -translate-y-1/2 flex-col gap-s4 overflow-y-auto',
          'rounded-card border border-line-strong bg-surface-1 p-s6 text-ink shadow-[var(--shadow-overlay)]',
          className,
        )}
        {...props}
      >
        <div className="flex flex-col gap-s1 pr-s8">
          <DialogPrimitive.Title className="t-h2 text-ink">{title}</DialogPrimitive.Title>
          {description != null && <DialogPrimitive.Description className="t-small text-muted">{description}</DialogPrimitive.Description>}
        </div>
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            aria-label="Close"
            className={cn('absolute right-s4 top-s4 inline-flex size-control-sm items-center justify-center rounded-control text-muted hover:bg-surface-2 hover:text-ink', focusRing)}
          >
            <X aria-hidden className="size-s4" />
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  ),
);
DialogContent.displayName = 'DialogContent';

/** The dialog's actions, right-aligned; the confirming action goes last. */
export function DialogFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col-reverse gap-s2 pt-s2 sm:flex-row sm:justify-end', className)} {...props} />;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  /** What the action will do and, for a paid action, what it will spend. */
  description: ReactNode;
  confirmLabel: string;
  /** `danger` for destructive actions, `primary` for paid or consequential ones. */
  tone?: 'danger' | 'primary';
  onConfirm: () => void;
  pending?: boolean;
  /** Holds the confirm button off while what the person must see before agreeing is not on the dialog yet. */
  confirmDisabled?: boolean;
  /** Why the last attempt failed; the dialog stays open so the failure is seen. */
  error?: string | null;
  children?: ReactNode;
}

/** The confirmation every destructive or paid action passes through. */
export function ConfirmDialog({
  open, onOpenChange, title, description, confirmLabel, tone = 'danger', onConfirm, pending = false, confirmDisabled = false, error = null, children,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!pending) onOpenChange(next); }}>
      <DialogContent title={title} description={description} hideClose>
        {children}
        {error != null && error !== '' && <p role="alert" className="t-small text-bad">{error}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>Cancel</Button>
          <Button variant={tone} onClick={onConfirm} pending={pending} disabled={confirmDisabled}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
