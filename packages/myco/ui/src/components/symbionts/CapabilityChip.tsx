import { Link } from 'react-router-dom';
import { StatusDot } from '../ui/status-dot';
import { cn } from '../../lib/cn';
import type { CapabilityChipDescriptor } from '../../lib/capability-map';

export interface CapabilityChipProps {
  chip: CapabilityChipDescriptor;
  /** Absolute path the chip navigates to. The Symbionts page resolves
   *  the project-relative `chip.to` against the active project before
   *  passing it here. */
  href: string;
}

/**
 * A clickable capability chip. The visual is a small pill with a status
 * dot + label; clicking navigates to the corresponding Myco feature
 * scoped to the relevant symbiont (e.g. `/sessions?agent=claude-code`).
 *
 * Disabled / hover / focus tokens use the same accent palette as
 * `StatusDot`, so the chip set on a row reads as a coherent group.
 */
export function CapabilityChip({ chip, href }: CapabilityChipProps) {
  return (
    <Link
      to={href}
      title={chip.title}
      aria-label={`${chip.label} — open feature`}
      data-capability={chip.id}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors',
        'border-outline-variant/30 bg-surface-container text-on-surface',
        'hover:bg-surface-container-high hover:border-outline-variant/60',
        'focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40',
      )}
    >
      <StatusDot tone={chip.tone} sizePx={5} />
      <span>{chip.label}</span>
    </Link>
  );
}
