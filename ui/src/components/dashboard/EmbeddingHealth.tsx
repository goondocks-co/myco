import { Cpu } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
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
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Cpu className="h-4 w-4 text-primary" />
          Embedding
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        {isLoading ? (
          <p className="text-muted-foreground">Loading...</p>
        ) : !data ? (
          <p className="text-muted-foreground">Unavailable</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Status</span>
              <Badge variant={statusVariant(data.status)} className="text-xs capitalize">
                {data.status}
              </Badge>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Provider</span>
              <span className="font-mono text-foreground">{data.provider}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground truncate mr-2">Model</span>
              <span className="font-mono text-xs text-foreground truncate max-w-[140px]" title={data.model}>
                {data.model}
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Queue</span>
              <span className="font-mono text-foreground">{data.queue_depth}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground">Embedded</span>
              <span className="font-mono text-foreground">
                {data.embedded_count} / {data.total_embeddable}
              </span>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
