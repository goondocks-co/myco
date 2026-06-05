import { Link } from 'react-router-dom';
import { StatusDot } from '../ui/status-dot';
import { cn } from '../../lib/cn';
import type { CapabilityChipDescriptor } from '../../lib/capability-map';

export interface CapabilityChipVisualProps {
  chip: CapabilityChipDescriptor;
}

/**
 * Presentational capability chip — StatusDot + label + shared Tailwind
 * tokens. Renders the pill with hover/transition styles but carries no
 * interaction logic; the consumer wraps it in a Link (Symbionts row) or
 * a button (Groves badge strip).
 */
export function CapabilityChipVisual({ chip }: CapabilityChipVisualProps) {
  return (
    <span
      data-capability={chip.id}
      title={chip.title}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        'border-outline-variant/30 bg-surface-container text-on-surface',
        'hover:bg-surface-container-high hover:border-outline-variant/60',
      )}
    >
      <StatusDot tone={chip.tone} sizePx={5} />
      <span>{chip.label}</span>
    </span>
  );
}

export interface CapabilityChipProps {
  chip: CapabilityChipDescriptor;
  /** Absolute path the chip navigates to. The Symbionts page resolves
   *  the project-relative `chip.to` against the active project before
   *  passing it here. */
  href: string;
}

/**
 * A clickable capability chip that navigates to the corresponding Myco
 * feature scoped to the relevant symbiont (e.g. `/sessions?agent=claude-code`).
 * Renders `CapabilityChipVisual` inside a `Link`; focus ring is applied
 * at the Link level.
 */
export function CapabilityChip({ chip, href }: CapabilityChipProps) {
  return (
    <Link
      to={href}
      aria-label={`${chip.label} — open feature`}
      className="focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40 rounded-full"
    >
      <CapabilityChipVisual chip={chip} />
    </Link>
  );
}
