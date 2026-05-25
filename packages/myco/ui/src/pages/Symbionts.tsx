/**
 * Symbionts page — every coding agent Myco supports, with capability
 * chips that deep-link into the Myco feature scoped to that symbiont.
 *
 * One list, one row per symbiont. Detected agents land at the top with
 * the live capability chips and a per-project override toggle; missing
 * agents fall to a muted "Not detected" group at the bottom and render
 * as inert rows (no chips, no toggle) so the user can see the full
 * supported set without confusing it with what's actually installed.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { PageHeader } from '../components/ui/page-header';
import { PageContainer } from '../components/ui/page-container';
import { Button } from '../components/ui/button';
import { Surface } from '../components/ui/surface';
import { SectionHeader } from '../components/ui/section-header';
import { SymbiontRow } from '../components/symbionts/SymbiontRow';
import { fetchJson } from '../lib/api';
import { useSymbionts } from '../hooks/use-symbionts';
import { useActiveProjectSelection } from '../hooks/use-project-selection';
import { usePatchProjectSymbionts } from '../hooks/use-project-symbionts';

export default function Symbionts() {
  const { data, isLoading, refetch } = useSymbionts();
  const queryClient = useQueryClient();
  const projectSelection = useActiveProjectSelection();
  const patchSymbionts = usePatchProjectSymbionts();
  const [detecting, setDetecting] = useState(false);

  const symbionts = data?.symbionts ?? [];
  const detected = symbionts.filter((s) => s.detected);
  const notDetected = symbionts.filter((s) => !s.detected);

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

  // The override toggle only makes sense when the user has a project
  // selected — that's the scope the override writes to. When no project
  // is selected the row still renders (capability chips remain useful)
  // but the toggle is rendered DISABLED with a tooltip explaining why,
  // rather than silently no-opping the click.
  const noProject = !projectSelection;
  const busy = patchSymbionts.isPending;

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
                  busy={busy}
                  overrideDisabled={noProject}
                  overrideDisabledReason={noProject ? 'Select a project to override this symbiont per-project.' : undefined}
                  onSetOverride={(enabled) => {
                    if (noProject) return;
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
