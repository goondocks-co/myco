import { forwardRef, type HTMLAttributes } from 'react';
import { cn } from '../../lib/cn';

/*
 * v7 Team Members avatar — 36px sage-dim → ochre gradient with mono uppercase
 * initials. Mirrors `.myco-team-member-avatar` from styles-v7.css.
 *
 * Initials are derived from the first two whitespace-separated word starts
 * when not explicitly provided; falls back to the first two letters of a
 * single word, or "?" if `name` is empty.
 */

export interface MemberAvatarProps extends HTMLAttributes<HTMLSpanElement> {
  /** Display name the initials fall back to when `initials` is not set. */
  name: string;
  /** Override the derived initials (max 2 characters recommended). */
  initials?: string;
  /** Edge length in pixels; defaults to 36 per v7. */
  size?: number;
}

function deriveInitials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return '?';
  const parts = trimmed.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

export const MemberAvatar = forwardRef<HTMLSpanElement, MemberAvatarProps>(
  ({ name, initials, size = 36, className, style, ...props }, ref) => {
    const text = (initials ?? deriveInitials(name)).slice(0, 2);
    return (
      <span
        ref={ref}
        aria-label={name}
        className={cn(
          'inline-flex items-center justify-center rounded-full font-mono font-semibold uppercase text-[var(--on-primary)] shrink-0',
          className,
        )}
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size / 3),
          background: 'linear-gradient(135deg, var(--sage-dim), var(--ochre))',
          ...style,
        }}
        {...props}
      >
        {text}
      </span>
    );
  },
);
MemberAvatar.displayName = 'MemberAvatar';

export { deriveInitials };
