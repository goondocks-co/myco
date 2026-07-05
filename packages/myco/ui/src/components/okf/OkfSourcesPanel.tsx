import { Panel } from '../ui/panel';
import type { OkfIncludeKind, OkfStatusResponse } from '../../hooks/use-okf';

const KIND_LABELS: Record<OkfIncludeKind, string> = {
  spores: 'Spores',
  canopy: 'Canopy',
  concepts: 'Concepts',
  guides: 'Guides',
};

const KIND_ORDER: OkfIncludeKind[] = ['spores', 'canopy', 'concepts', 'guides'];

export interface OkfSourcesPanelProps {
  status: OkfStatusResponse;
}

export function OkfSourcesPanel({ status }: OkfSourcesPanelProps) {
  const counts = status.counts;

  return (
    <Panel eyebrow="Bundle contents" title="Sources">
      <div className="flex flex-col divide-y divide-outline-variant/15">
        {KIND_ORDER.map((kind) => (
          <div key={kind} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
            <span className="text-sm text-on-surface">{KIND_LABELS[kind]}</span>
            <span className="font-mono text-xs text-on-surface-variant">
              {counts ? counts[kind] : '—'}
            </span>
          </div>
        ))}
      </div>
    </Panel>
  );
}
