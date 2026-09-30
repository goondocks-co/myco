import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/** Up to two initials from a name: the first letters of the first two words, else the first two letters, else "?". */
export function initialsOf(name: string): string {
  const trimmed = name.trim();
  if (trimmed === '') return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]![0]!}${parts[1]![0]!}`.toUpperCase();
  return trimmed.slice(0, 2).toUpperCase();
}

const SIZE = {
  sm: 'size-s6 t-meta',
  md: 'size-[28px] t-meta',
  lg: 'size-s10 t-small',
} as const;

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** The member's name; the avatar's accessible name and the source of its initials. */
  name: string;
  size?: keyof typeof SIZE;
}

/** A member's initials in a primary-tinted circle. */
export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(({ name, size = 'md', className, ...props }, ref) => (
  <span
    ref={ref}
    role="img"
    aria-label={name}
    className={cn('inline-grid shrink-0 place-items-center rounded-pill bg-primary-bg font-semibold text-primary', SIZE[size], className)}
    {...props}
  >
    <span aria-hidden>{initialsOf(name)}</span>
  </span>
));
Avatar.displayName = 'Avatar';
