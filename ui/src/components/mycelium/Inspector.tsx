import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import type { GraphNode } from '../../hooks/use-graph-canvas';

interface InspectorProps {
  node: GraphNode | null;
  metadata?: Record<string, string>;
  markdownPreview?: string;
  connectedSpores?: Array<{ id: string; name: string; type: string }>;
  onClose?: () => void;
}

export function Inspector({ node, metadata, markdownPreview, connectedSpores, onClose }: InspectorProps) {
  if (!node) return null;

  return (
    <Surface glass className="w-[300px] shrink-0 p-4 space-y-4 overflow-y-auto max-h-full">
      <div className="flex items-start justify-between">
        <div>
          <Badge variant="default" className="mb-1">{node.type}</Badge>
          <h2 className="font-serif text-lg text-on-surface">{node.name}</h2>
        </div>
        {onClose && (
          <button onClick={onClose} className="text-on-surface-variant hover:text-on-surface text-sm">&times;</button>
        )}
      </div>

      {metadata && (
        <div className="space-y-1.5">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">Metadata</div>
          {Object.entries(metadata).map(([key, value]) => (
            <div key={key} className="flex justify-between text-xs">
              <span className="font-sans text-on-surface-variant">{key}</span>
              <span className="font-mono text-on-surface">{value}</span>
            </div>
          ))}
        </div>
      )}

      {markdownPreview && (
        <div className="space-y-1.5">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">Notes</div>
          <div className="font-sans text-xs text-on-surface-variant whitespace-pre-wrap leading-relaxed">{markdownPreview}</div>
        </div>
      )}

      {connectedSpores && connectedSpores.length > 0 && (
        <div className="space-y-1.5">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">Connected Spores</div>
          <div className="flex flex-wrap gap-1">
            {connectedSpores.map((s) => (
              <Badge key={s.id} variant="secondary" className="cursor-pointer text-xs">{s.name}</Badge>
            ))}
          </div>
        </div>
      )}

      <div className="flex gap-2 pt-2">
        <Button variant="secondary" size="sm">Edit</Button>
        <Button variant="secondary" size="sm">Analyze</Button>
      </div>
    </Surface>
  );
}
