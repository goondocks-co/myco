import { useState } from 'react';
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
 * Master/detail surface for Canopy entries. The list always renders full
 * width; selecting a row reveals a right-side slide-out detail panel
 * (mirroring the Mycelium Inspector pattern). The slide-out is absolutely
 * positioned over the right edge of the relative container so the list
 * stays scannable while the detail floats on top.
 */
export function CanopyEntriesPanel({ defaultPath }: CanopyEntriesPanelProps = {}) {
  const [selectedPath, setSelectedPath] = useState<string | undefined>(defaultPath);

  return (
    <div className="relative space-y-6">
      <CanopyEntriesList
        selectedPath={selectedPath}
        onSelectPath={setSelectedPath}
      />

      {selectedPath ? (
        <CanopyEntryDetail
          path={selectedPath}
          onClose={() => setSelectedPath(undefined)}
        />
      ) : null}
    </div>
  );
}
