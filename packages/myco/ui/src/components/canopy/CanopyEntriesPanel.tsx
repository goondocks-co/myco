import { useEffect, useState } from 'react';
import { Trees } from 'lucide-react';
import { Surface } from '../ui/surface';
import { CanopyEntriesList } from './CanopyEntriesList';
import { CanopyEntryDetail } from './CanopyEntryDetail';

interface CanopyEntriesPanelProps {
  /**
   * Optional path to pre-select when the panel mounts. Sourced from a URL
   * param (e.g. `?tab=canopy-entries&path=…`) so deep-links from universal
   * search land directly on the entry detail.
   */
  initialPath?: string;
}

/**
 * Stacked master-detail surface. The list stays visible above the detail
 * panel so users can hop between rows without losing context. This mirrors
 * the daemon UI's existing convention for narrow workspaces — see the
 * Skills tab for a comparable pattern, where `Skills.tsx` switches between
 * list-only and a back-buttoned detail. Here we keep both visible because
 * the entry detail tends to be short (description + metadata + a few
 * symbols) and users browse by skimming.
 */
export function CanopyEntriesPanel({ initialPath }: CanopyEntriesPanelProps = {}) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(initialPath);

  // Re-seed when the URL-supplied path changes (e.g. user clicks a different
  // file from the universal search while the panel is already mounted).
  useEffect(() => {
    if (initialPath) setSelectedPath(initialPath);
  }, [initialPath]);

  return (
    <div className="space-y-6">
      <Surface level="low" className="rounded-lg border border-primary/15 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Trees className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="font-sans text-sm font-medium text-on-surface">
              Browse the canopy index — what Cortex offers agents on Read.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Each row is a single file with its mechanical anatomy and any Tier 2
              LLM description. Click a row to see the full details and to queue a
              re-embed when a description has drifted.
            </p>
          </div>
        </div>
      </Surface>

      <CanopyEntriesList
        selectedPath={selectedPath}
        onSelectPath={setSelectedPath}
      />

      {selectedPath ? (
        <Surface level="low" className="rounded-lg border border-outline-variant/20 p-6">
          <CanopyEntryDetail
            path={selectedPath}
            onBack={() => setSelectedPath(undefined)}
          />
        </Surface>
      ) : null}
    </div>
  );
}
