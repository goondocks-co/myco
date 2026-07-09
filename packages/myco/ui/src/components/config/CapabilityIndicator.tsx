import { Link } from 'react-router-dom';
import { CAPABILITIES, capabilityEnabled } from '@myco/config/capabilities';
import type { CapabilityId } from '@myco/config/scope';
import type { MycoConfig } from '@myco/config/schema';
import { StatusDot } from '../ui/status-dot';
import { useScopedConfig } from '../../hooks/use-scoped-config';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';

/**
 * The capability on/off chip every capability-gated section page carries in
 * its header. One consistent pattern: the chip SHOWS state; clicking it
 * deep-links to the Groves page with the active project's capability panel
 * open — the single place capabilities are toggled. Section pages never embed
 * their own enable switch.
 *
 * Renders nothing until the merged config resolves, so a loading project
 * never flashes a wrong state.
 */
export function CapabilityIndicator({ capability }: { capability: CapabilityId }) {
  const { effective } = useScopedConfig();
  const selection = useActiveProjectSelection();
  if (!effective) return null;

  const def = CAPABILITIES[capability];
  const enabled = capabilityEnabled(effective as MycoConfig, capability);
  const to = selection
    ? `/groves?capabilities=${encodeURIComponent(selection.project.project_id)}`
    : '/groves';

  return (
    <Link
      to={to}
      data-testid={`capability-indicator-${capability}`}
      title={`${def.label} is ${enabled ? 'enabled' : 'disabled'} for this project — manage capabilities on the Groves page`}
      className="flex items-center gap-1.5 rounded-md border border-outline-variant px-2.5 py-1 transition-colors hover:bg-surface-container-high focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <StatusDot tone={enabled ? 'sage' : 'outline'} />
      <span className="font-mono text-xs text-on-surface-variant">
        {def.label} {enabled ? 'on' : 'off'}
      </span>
    </Link>
  );
}
