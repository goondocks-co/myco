import { Cpu } from 'lucide-react';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { useEmbeddingStatus } from '../../hooks/use-embedding';

/* ---------- Helpers ---------- */

function statusVariant(
  status: 'idle' | 'pending' | 'unavailable',
): 'default' | 'secondary' | 'destructive' {
  switch (status) {
    case 'idle':
      return 'secondary';
    case 'pending':
      return 'default';
    case 'unavailable':
      return 'destructive';
  }
}

/* ---------- Component ---------- */

export function EmbeddingHealth() {
  const { data, isLoading } = useEmbeddingStatus();

  return (
    <Surface level="low" className="p-4 space-y-2">
      <h3 className="font-serif text-sm text-on-surface flex items-center gap-2">
        <Cpu className="h-4 w-4 text-primary" />
        Embedding
      </h3>
      {isLoading ? (
        <p className="font-sans text-sm text-on-surface-variant">Loading...</p>
      ) : !data ? (
        <p className="font-sans text-sm text-on-surface-variant">Unavailable</p>
      ) : (
        <div className="space-y-2 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Status</span>
            <Badge variant={statusVariant(data.status)} className="capitalize">
              {data.status}
            </Badge>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Provider</span>
            <span className="font-mono text-xs text-on-surface">{data.provider}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant truncate mr-2">Model</span>
            <span className="font-mono text-xs text-on-surface truncate max-w-[140px]" title={data.model}>
              {data.model}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Queue</span>
            <span className="font-mono text-xs text-on-surface">{data.queue_depth}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="font-sans text-xs text-on-surface-variant">Embedded</span>
            <span className="font-mono text-xs text-on-surface">
              {data.embedded_count} / {data.total_embeddable}
            </span>
          </div>
        </div>
      )}
    </Surface>
  );
}
