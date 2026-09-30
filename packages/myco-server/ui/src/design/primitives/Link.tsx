import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing, tapTarget } from '../lib/classes';

const linkClass = cn('rounded-chip text-primary underline decoration-[color-mix(in_srgb,var(--primary)_45%,transparent)] underline-offset-[3px] hover:decoration-primary', focusRing);

export type LinkProps = RouterLinkProps;

/** A link inside text or a metadata line, to a page of the dashboard. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(({ className, ...props }, ref) => (
  <RouterLink ref={ref} className={cn(linkClass, className)} {...props} />
));
Link.displayName = 'Link';

/**
 * A link that stands on its own as the next step, such as "Open the run →":
 * the primary colour, no underline until hovered, and a whole fingertip wide
 * on a touch-sized screen.
 */
export const ActionLink = forwardRef<HTMLAnchorElement, LinkProps>(({ className, ...props }, ref) => (
  <RouterLink ref={ref} className={cn(tapTarget, 'w-fit rounded-chip t-small font-medium text-primary hover:underline', focusRing, className)} {...props} />
));
ActionLink.displayName = 'ActionLink';

export interface ItemLinkProps extends LinkProps {
  /** How many lines the text may take before it is cut short. */
  lines?: 1 | 2;
}

/**
 * A record's line in a list, such as a spore under a session: the text in its
 * own colour, underlined on hover, cut short past `lines`, and a fingertip tall
 * on a touch-sized screen.
 */
export const ItemLink = forwardRef<HTMLAnchorElement, ItemLinkProps>(({ className, lines = 2, children, ...props }, ref) => (
  <RouterLink
    ref={ref}
    className={cn('flex min-h-tap min-w-0 items-center rounded-chip hover:underline hover:decoration-line-strong hover:underline-offset-3', focusRing, className)}
    {...props}
  >
    <span className={cn('min-w-0', lines === 1 ? 'truncate' : 'line-clamp-2')}>{children}</span>
  </RouterLink>
));
ItemLink.displayName = 'ItemLink';

export type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** A link that leaves the dashboard; it opens in a new tab. */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(({ className, ...props }, ref) => (
  <a ref={ref} target="_blank" rel="noreferrer" className={cn(linkClass, className)} {...props} />
));
ExternalLink.displayName = 'ExternalLink';
