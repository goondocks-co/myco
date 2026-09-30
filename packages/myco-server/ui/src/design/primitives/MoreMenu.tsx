import { forwardRef, type ComponentPropsWithoutRef, type ElementRef, type ReactNode } from 'react';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, MoreHorizontal } from 'lucide-react';
import { cn } from '../../lib/cn';
import { overlaySurface } from '../lib/classes';
import { Button, IconButton } from './Button';

export interface MoreMenuItem {
  label: string;
  onSelect: () => void;
  /** Destructive items read in the failure colour and sit after a separator. */
  tone?: 'danger';
  disabled?: boolean;
  icon?: ReactNode;
}

export interface MoreMenuProps {
  items: readonly MoreMenuItem[];
  /** Names the trigger; defaults to "More actions". */
  label?: string;
  align?: 'start' | 'end';
}

/** The ⋯ menu: the home of destructive and paid actions and "Copy id". Radix handles focus and arrow keys. */
export function MoreMenu({ items, label = 'More actions', align = 'end' }: MoreMenuProps) {
  const safe = items.filter((item) => item.tone !== 'danger');
  const danger = items.filter((item) => item.tone === 'danger');
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <IconButton label={label} size="sm">
          <MoreHorizontal aria-hidden className="size-s4" />
        </IconButton>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align={align} sideOffset={4} className={cn(overlaySurface, 'z-50 min-w-[192px] p-s1')}>
          {safe.map((item) => <MoreMenuEntry key={item.label} item={item} />)}
          {safe.length > 0 && danger.length > 0 && <Menu.Separator className="my-s1 h-px bg-line" />}
          {danger.map((item) => <MoreMenuEntry key={item.label} item={item} />)}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

function MoreMenuEntry({ item }: { item: MoreMenuItem }) {
  return (
    <MenuItem onSelect={item.onSelect} disabled={item.disabled} className={cn(item.tone === 'danger' && 'text-bad data-[highlighted]:text-bad')}>
      {item.icon}
      {item.label}
    </MenuItem>
  );
}

/** One row of a menu. */
export const MenuItem = forwardRef<ElementRef<typeof Menu.Item>, ComponentPropsWithoutRef<typeof Menu.Item>>(({ className, ...props }, ref) => (
  <Menu.Item
    ref={ref}
    className={cn(
      'flex h-control-sm cursor-default select-none items-center gap-s2 rounded-chip px-s2 t-control text-ink-2 outline-none',
      'data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink data-[disabled]:opacity-50',
      className,
    )}
    {...props}
  />
));
MenuItem.displayName = 'MenuItem';

export interface ActionMenuItem {
  label: string;
  /** One line under the label: what it will do, or why it can't be chosen now. */
  detail?: string;
  onSelect: () => void;
  disabled?: boolean;
}

export interface ActionMenuProps {
  /** The trigger's words, as in "Run a task". */
  label: string;
  items: readonly ActionMenuItem[];
  icon?: ReactNode;
  align?: 'start' | 'end';
}

/** A labelled button that opens a list of actions, each with a line saying what it will do or why it waits. */
export function ActionMenu({ label, items, icon, align = 'end' }: ActionMenuProps) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button variant="secondary" icon={icon}>
          {label}
          <ChevronDown aria-hidden className="size-s4 text-muted" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content align={align} sideOffset={4} className={cn(overlaySurface, 'z-50 w-[min(320px,calc(100vw-var(--s-8)))] p-s1')}>
          {items.map((item) => (
            <Menu.Item
              key={item.label}
              onSelect={item.onSelect}
              disabled={item.disabled}
              className={cn(
                'flex cursor-default select-none flex-col gap-s1 rounded-chip px-s3 py-s2 outline-none',
                'data-[highlighted]:bg-surface-3 data-[disabled]:opacity-60',
              )}
            >
              <span className="t-control text-ink">{item.label}</span>
              {item.detail !== undefined && <span className="t-meta text-muted">{item.detail}</span>}
            </Menu.Item>
          ))}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
