import { Panel } from '../ui/panel';
import type { OkfStatusResponse } from '../../hooks/use-okf';

export interface OkfSourcesPanelProps {
  status: OkfStatusResponse;
}

export function OkfSourcesPanel({ status }: OkfSourcesPanelProps) {
  // OKF documents are grouped by their frontmatter `type`, not by Myco source
  // kind — the bundle is a portable knowledge wiki, not a projection of Myco
  // tables.
  const byType = status.byType;
  const entries = byType ? Object.entries(byType).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)) : [];

  return (
    <Panel eyebrow="Bundle contents" title="Pages by type">
      <div className="flex flex-col divide-y divide-outline-variant/15">
        {entries.length === 0 ? (
          <div className="py-2 text-sm text-on-surface-variant">No published pages yet.</div>
        ) : (
          entries.map(([type, count]) => (
            <div key={type} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
              <span className="text-sm text-on-surface">{type}</span>
              <span className="font-mono text-xs text-on-surface-variant">{count}</span>
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}
