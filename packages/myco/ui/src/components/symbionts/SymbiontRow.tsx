import { useMemo } from 'react';
import { Row } from '../ui/row';
import { Switch } from '../ui/switch';
import { StatusDot } from '../ui/status-dot';
import { CapabilityChip } from './CapabilityChip';
import { buildCapabilityChips } from '../../lib/capability-map';
import { useProjectPathBuilder } from '../../hooks/use-project-selection';
import type { SymbiontInfo } from '../../hooks/use-symbionts';

/**
 * Decide the leading status-dot tone + label from the symbiont's
 * detection / install / effective-enabled flags. Three cases:
 *
 *  - "Available" (sage, pulse off): detected on this machine and Myco's
 *    global config is wired in. The normal happy path.
 *  - "Detected" (ochre): detected but Myco isn't globally installed yet.
 *    The user can install via the Operations / re-detect flow.
 *  - "Not detected" (outline): manifest exists but the symbiont isn't
 *    installed on this machine. Shown as muted; no actions.
 *
 * If a project override is disabling the symbiont, the row stays in
 * its detected/available state but the toggle reflects the override.
 */
function describeStatus(s: SymbiontInfo): { label: string; tone: 'sage' | 'ochre' | 'outline' } {
  if (!s.detected) return { label: 'Not detected', tone: 'outline' };
  if (!s.globallyInstalled) return { label: 'Detected', tone: 'ochre' };
  return { label: 'Available', tone: 'sage' };
}

export interface SymbiontRowProps {
  symbiont: SymbiontInfo;
  /** Per-project override toggle handlers — passed from the page so the
   *  row stays free of mutation-hook wiring. */
  onSetOverride: (enabled: boolean) => void;
  onResetOverride: () => void;
  busy?: boolean;
}

export function SymbiontRow({ symbiont, onSetOverride, onResetOverride, busy = false }: SymbiontRowProps) {
  const status = describeStatus(symbiont);
  const projectPath = useProjectPathBuilder();
  const chips = useMemo(() => buildCapabilityChips(symbiont), [symbiont]);

  // Toggle reflects the EFFECTIVE state. Clicking it acts as follows:
  //   - currently ON, user toggles off  -> write { enabled: false } (opt out).
  //   - currently OFF (override = false), user toggles on -> clear the
  //     override so it falls back to the global default.
  // The latter is "reset" rather than "write enabled: true" because the
  // global default is the right answer 99% of the time, and not pinning
  // `true` here keeps the project file from accumulating stale entries.
  function handleToggle(next: boolean) {
    if (next && symbiont.projectOverride && symbiont.projectOverride.enabled === false) {
      onResetOverride();
    } else if (!next) {
      onSetOverride(false);
    } else {
      // Edge: no override and user wants ON, but effective is OFF for
      // some reason (e.g. global default disabled). Pin an explicit
      // override of true so the symbiont runs in this project.
      onSetOverride(true);
    }
  }

  return (
    <Row accent="sage" interactive={false} data-symbiont={symbiont.name}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-start gap-2.5 min-w-0 flex-1">
          <StatusDot tone={status.tone} className="mt-1.5 shrink-0" />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2 flex-wrap">
              <h3 className="font-serif italic text-sm text-on-surface truncate leading-snug">
                {symbiont.displayName}
              </h3>
              <span className="font-mono text-[10px] text-on-surface-variant">
                {symbiont.name}
              </span>
              <span className="font-mono text-[10px] text-on-surface-variant">
                · {status.label}
              </span>
              {symbiont.projectOverride && (
                <span className="font-mono text-[10px] text-ochre">
                  · project override
                </span>
              )}
            </div>

            {chips.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {chips.map((chip) => (
                  <CapabilityChip key={chip.id} chip={chip} href={projectPath(chip.to)} />
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Override toggle is only meaningful for detected symbionts.
            For not-detected entries, hide the toggle entirely. */}
        {symbiont.detected && (
          <div className="flex items-center gap-2 shrink-0">
            <Switch
              checked={symbiont.enabled}
              onCheckedChange={handleToggle}
              disabled={busy}
            />
          </div>
        )}
      </div>
    </Row>
  );
}
