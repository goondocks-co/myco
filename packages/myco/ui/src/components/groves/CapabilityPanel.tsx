import { Link } from 'react-router-dom';
import { CAPABILITIES, capabilityEnabled } from '@myco/config/capabilities';
import type { MycoConfig } from '@myco/config/schema';
import type { CapabilityId } from '@myco/config/scope';
import { CAPABILITY_IDS } from '@myco/config/scope';
import { useScopedConfigForSelection } from '../../hooks/use-scoped-config';
import { SlideoutDetailPanel } from '../ui/slideout-detail-panel';
import { Switch } from '../ui/switch';
import type { GroveSummary, GroveProjectSummary } from '../../lib/selection';

export interface CapabilityPanelProps {
  target: { grove: GroveSummary; project: GroveProjectSummary };
  open: boolean;
  onClose: () => void;
}

function CapabilityToggleRow({
  capId,
  scoped,
}: {
  capId: CapabilityId;
  scoped: ReturnType<typeof useScopedConfigForSelection>;
}) {
  const cap = CAPABILITIES[capId];
  const enabled = capabilityEnabled(scoped.effective as MycoConfig, capId);

  return (
    <div className="flex items-start justify-between gap-4 py-3 border-b border-outline-variant/15 last:border-b-0">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-on-surface">{cap.label}</div>
        <Link
          to={cap.advancedSettingsLink}
          className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
        >
          Advanced settings →
        </Link>
      </div>
      <Switch
        checked={enabled}
        onCheckedChange={(next) => {
          void scoped.setFields([{ path: cap.masterGate as never, value: next }], 'local');
        }}
      />
    </div>
  );
}

/**
 * Slide-out panel for viewing and editing per-project capability toggles.
 * Each switch flips the capability master gate at Personal (local) scope,
 * so settings apply only to this machine and don't override team config.
 */
export function CapabilityPanel({ target, open, onClose }: CapabilityPanelProps) {
  const scoped = useScopedConfigForSelection(target);

  return (
    <SlideoutDetailPanel
      open={open}
      onClose={onClose}
      ariaLabel="Project capabilities"
      testIdRoot="capability-panel"
    >
      <div className="flex flex-col gap-1 mb-5">
        <div className="text-xs font-medium uppercase tracking-wide text-on-surface-variant">
          Capabilities
        </div>
        <div className="text-base font-semibold text-on-surface">{target.project.name}</div>
        <div className="text-xs text-on-surface-variant">
          Toggles apply at Personal scope — only this machine.
        </div>
      </div>

      <div className="flex flex-col">
        {(CAPABILITY_IDS as readonly CapabilityId[]).map((capId) => (
          <CapabilityToggleRow key={capId} capId={capId} scoped={scoped} />
        ))}
      </div>

      <div className="mt-5 pt-4 border-t border-outline-variant/15">
        <button
          type="button"
          className="text-xs text-on-surface-variant hover:text-on-surface transition-colors"
          onClick={() => {
            void scoped.resetFields(
              CAPABILITY_IDS.map((id) => CAPABILITIES[id].masterGate as never),
            );
          }}
        >
          Reset to defaults
        </button>
      </div>
    </SlideoutDetailPanel>
  );
}
