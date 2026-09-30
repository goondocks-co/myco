import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

export interface SwitchProps extends Omit<ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>, 'onCheckedChange' | 'checked'> {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/** A real on/off switch. Name it with `aria-label` or a `<label htmlFor>`; its state is read out as checked or not. */
export const Switch = forwardRef<ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(({ className, ...props }, ref) => (
  <SwitchPrimitive.Root
    ref={ref}
    className={cn(
      'peer inline-flex h-s5 w-[36px] shrink-0 cursor-pointer items-center rounded-pill border border-line-strong bg-surface-3 p-px transition-colors duration-120',
      'data-[state=checked]:border-primary data-[state=checked]:bg-primary disabled:cursor-not-allowed disabled:opacity-50',
      focusRing,
      className,
    )}
    {...props}
  >
    <SwitchPrimitive.Thumb
      className={cn(
        'pointer-events-none block size-s4 rounded-pill bg-ink-2 transition-transform duration-120',
        'data-[state=checked]:translate-x-s4 data-[state=checked]:bg-on-primary',
      )}
    />
  </SwitchPrimitive.Root>
));
Switch.displayName = 'Switch';
