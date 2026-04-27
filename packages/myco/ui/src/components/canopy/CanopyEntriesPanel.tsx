import { useState } from 'react';
import { Trees } from 'lucide-react';
import { Surface } from '../ui/surface';
import { CanopyEntriesList } from './CanopyEntriesList';
import { CanopyEntryDetail } from './CanopyEntryDetail';

interface CanopyEntriesPanelProps {
  /**
   * Optional path to seed the selection when the panel first mounts.
   * Treated as a default, not a controlled value — to switch to a different
   * URL-supplied path the parent must remount the component (use a `key`
   * prop tied to the URL param).
   */
  defaultPath?: string;
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
export function CanopyEntriesPanel({ defaultPath }: CanopyEntriesPanelProps = {}) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(defaultPath);

  return (
    <div className="space-y-6">
      <Surface level="low" className="rounded-lg border border-primary/15 p-5">
        <div className="flex flex-wrap items-start gap-3">
          <div className="rounded-md bg-primary/10 p-2 text-primary">
            <Trees className="h-4 w-4" />
          </div>
          <div className="space-y-1">
            <p className="font-sans text-sm font-medium text-on-surface">
              Every described file in your project.
            </p>
            <p className="max-w-3xl font-sans text-sm text-on-surface-variant">
              Click a row to see what the Myco agent recorded — the file's
              description, exports, imports, and top comment. Re-embed any
              row whose description has drifted from the latest content.
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
      ) : (
        <Surface
          level="low"
          className="rounded-lg border border-outline-variant/20 p-8"
          data-testid="canopy-entry-detail-placeholder"
        >
          <p className="text-center font-sans text-sm text-on-surface-variant">
            Select a file to see its description, exports, and metadata.
          </p>
        </Surface>
      )}
    </div>
  );
}
