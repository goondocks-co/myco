import { forwardRef, type AnchorHTMLAttributes } from 'react';
import { Link as RouterLink, type LinkProps as RouterLinkProps } from 'react-router-dom';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';

const linkClass = cn('rounded-chip text-primary underline decoration-[color-mix(in_srgb,var(--primary)_45%,transparent)] underline-offset-[3px] hover:decoration-primary', focusRing);

export type LinkProps = RouterLinkProps;

/** A link inside text or a metadata line, to a page of the dashboard. */
export const Link = forwardRef<HTMLAnchorElement, LinkProps>(({ className, ...props }, ref) => (
  <RouterLink ref={ref} className={cn(linkClass, className)} {...props} />
));
Link.displayName = 'Link';

export type ExternalLinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

/** A link that leaves the dashboard; it opens in a new tab. */
export const ExternalLink = forwardRef<HTMLAnchorElement, ExternalLinkProps>(({ className, ...props }, ref) => (
  <a ref={ref} target="_blank" rel="noreferrer" className={cn(linkClass, className)} {...props} />
));
ExternalLink.displayName = 'ExternalLink';
