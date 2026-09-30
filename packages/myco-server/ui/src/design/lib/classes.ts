/** The one focus ring: the primary colour at 2px, offset 2px, on keyboard focus only. */
export const focusRing = 'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

/** The shared frame of a text field or select trigger: control height, control radius, a strong line, the panel surface. */
export const fieldFrame = 'h-control w-full min-w-0 rounded-control border border-line-strong bg-surface-1 px-s3 t-control text-ink transition-colors duration-120 placeholder:text-faint hover:border-faint focus-visible:border-primary disabled:cursor-not-allowed disabled:opacity-50';

/** A floating layer: menus, select lists and popovers. */
export const overlaySurface = 'rounded-control border border-line-strong bg-surface-2 text-ink shadow-[var(--shadow-overlay)]';
