/**
 * Symbionts page — every coding agent Myco supports, with capability
 * chips that deep-link into the Myco feature scoped to that symbiont.
 *
 * Per-project customization is a single page-level toggle. ON ensures
 * the project's myco.yaml carries an explicit `symbionts:` block and
 * makes per-symbiont toggles meaningful; OFF removes the block entirely
 * so the project follows global defaults. Per-symbiont toggles are
 * disabled when customization is OFF — never silently no-op.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PageContainer } from '../components/ui/page-container';
import { Button } from '../components/ui/button';
import { Switch } from '../components/ui/switch';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { SymbiontRow } from '../components/symbionts/SymbiontRow';
import { fetchJson } from '../lib/api';
import { useSymbionts } from '../hooks/use-symbionts';
import { useActiveProjectSelection } from '../hooks/use-project-selection';
import {
  usePatchProjectSymbionts,
  useSetProjectSymbiontCustomization,
} from '../hooks/use-project-symbionts';

export default function Symbionts() {
  const { data, isLoading, refetch } = useSymbionts();
  const queryClient = useQueryClient();
  const projectSelection = useActiveProjectSelection();
  const patchSymbionts = usePatchProjectSymbionts();
  const setCustomization = useSetProjectSymbiontCustomization();
  const [detecting, setDetecting] = useState(false);

  const symbionts = data?.symbionts ?? [];
  const detected = symbionts.filter((s) => s.detected);
  const notDetected = symbionts.filter((s) => !s.detected);
  const customizationActive = !!data?.projectCustomizationActive;
  const noProject = !projectSelection;

  async function redetect() {
    setDetecting(true);
    try {
      await fetchJson('/symbionts/detect', { method: 'POST' });
      await queryClient.invalidateQueries({ queryKey: ['symbionts'] });
      await refetch();
    } finally {
      setDetecting(false);
    }
  }

  function handleCustomizationToggle(next: boolean) {
    if (noProject) return;
    setCustomization.mutate({ enabled: next });
  }

  const customizationBusy = setCustomization.isPending;
  const perRowBusy = patchSymbionts.isPending || customizationBusy;
  const perRowDisabled = noProject || !customizationActive;
  const perRowDisabledReason = noProject
    ? 'Select a project to override this symbiont per-project.'
    : !customizationActive
      ? 'Turn on "Customize for this project" to override individual symbionts here.'
      : undefined;

  return (
    <PageContainer>
      <PageHeader
        title="Symbionts"
        description="Coding agents Myco supports on this machine, and the Myco features available for each."
        actions={
          <Button onClick={redetect} disabled={detecting} variant="outline" size="sm">
            <RefreshCw className={`h-4 w-4 mr-1.5 ${detecting ? 'animate-spin' : ''}`} />
            {detecting ? 'Detecting…' : 'Re-detect now'}
          </Button>
        }
      />

      {/* Page-level customization toggle. When a project is selected and
          this is ON, per-symbiont toggles below become live; when OFF,
          the project follows global defaults and the symbionts block is
          REMOVED from the project's myco.yaml. */}
      <Surface className="px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="font-sans text-sm text-on-surface">Customize for this project</div>
            <div className="mt-0.5 font-sans text-xs text-on-surface-variant">
              {noProject
                ? 'Select a project from the switcher to enable per-project customization.'
                : customizationActive
                  ? 'This project overrides which symbionts are active. Toggle individual symbionts below.'
                  : 'Using the global defaults. Turn on to override individual symbionts for this project.'}
            </div>
          </div>
          <Switch
            checked={customizationActive}
            onCheckedChange={handleCustomizationToggle}
            disabled={noProject || customizationBusy}
          />
        </div>
      </Surface>

      {isLoading ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : (
        <div className="space-y-6">
          <Surface>
            {detected.length === 0 ? (
              <p className="px-4 py-6 text-sm text-on-surface-variant">
                No coding agents detected. Myco picks them up automatically once one is installed.
              </p>
            ) : (
              detected.map((s) => (
                <SymbiontRow
                  key={s.name}
                  symbiont={s}
                  busy={perRowBusy}
                  overrideDisabled={perRowDisabled}
                  overrideDisabledReason={perRowDisabledReason}
                  onSetOverride={(enabled) => {
                    if (perRowDisabled) return;
                    patchSymbionts.mutate({ symbionts: { [s.name]: { enabled } } });
                  }}
                />
              ))
            )}
          </Surface>

          {notDetected.length > 0 && (
            <div className="space-y-2">
              <SectionHeader>Not detected</SectionHeader>
              <Surface>
                {notDetected.map((s) => (
                  <SymbiontRow
                    key={s.name}
                    symbiont={s}
                    onSetOverride={() => {}}
                  />
                ))}
              </Surface>
            </div>
          )}
        </div>
      )}
    </PageContainer>
  );
}
