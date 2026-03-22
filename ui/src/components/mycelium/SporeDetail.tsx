import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, ArrowRight, ExternalLink } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { MetaRow } from '../ui/meta-row';
import { useSpore } from '../../hooks/use-spores';
import { cn } from '../../lib/cn';
import { formatEpochAgo, formatEpochAbsolute } from '../../lib/format';
import { observationTypeClass, statusClass, formatLabel } from './helpers';

/* ---------- Sub-components ---------- */

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold',
        observationTypeClass(type),
      )}
    >
      {formatLabel(type)}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold',
        statusClass(status),
      )}
    >
      {formatLabel(status)}
    </span>
  );
}

/* ---------- Component ---------- */

export interface SporeDetailProps {
  id: string;
  onBack: () => void;
  onNavigateToSpore?: (id: string) => void;
  onNavigateToGraph?: (entityId: string) => void;
}

export function SporeDetail({ id, onBack, onNavigateToSpore, onNavigateToGraph: _onNavigateToGraph }: SporeDetailProps) {
  const navigate = useNavigate();
  const { data: spore, isLoading, isError, error } = useSpore(id);

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span>Loading spore...</span>
      </div>
    );
  }

  if (isError || !spore) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span className="text-sm">Spore not found</span>
        <span className="text-xs text-muted-foreground">
          {error instanceof Error ? error.message : 'Unknown error'}
        </span>
      </div>
    );
  }

  const tags = spore.tags
    ? spore.tags.split(',').map((t) => t.trim()).filter(Boolean)
    : [];

  return (
    <div className="space-y-6">
      {/* Back nav */}
      <Button
        variant="ghost"
        size="sm"
        onClick={onBack}
        className="gap-2 text-muted-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        Spores
      </Button>

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <TypeBadge type={spore.observation_type} />
        <StatusBadge status={spore.status} />
        {spore.importance !== null && (
          <span className="text-xs text-muted-foreground">
            Importance: <span className="text-foreground font-medium">{spore.importance.toFixed(1)}</span>
          </span>
        )}
        <span className="text-xs text-muted-foreground ml-auto">
          {formatEpochAgo(spore.created_at)}
        </span>
      </div>

      {/* Content */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Observation</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-foreground whitespace-pre-wrap">{spore.content}</p>
        </CardContent>
      </Card>

      {/* Context */}
      {spore.context && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Context</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{spore.context}</p>
          </CardContent>
        </Card>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full border border-border bg-muted px-2.5 py-0.5 text-xs text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Resolution history */}
      {(spore.predecessor_id || spore.successor_id) && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Resolution History</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {spore.predecessor_id && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Supersedes</span>
                <button
                  className="font-mono text-primary hover:underline flex items-center gap-1"
                  onClick={() => onNavigateToSpore?.(spore.predecessor_id!)}
                >
                  {spore.predecessor_id.slice(0, 8)}
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
            {spore.successor_id && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Superseded by</span>
                <button
                  className="font-mono text-primary hover:underline flex items-center gap-1"
                  onClick={() => onNavigateToSpore?.(spore.successor_id!)}
                >
                  {spore.successor_id.slice(0, 8)}
                  <ArrowRight className="h-3 w-3" />
                </button>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Metadata sidebar */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Metadata</CardTitle>
        </CardHeader>
        <CardContent className="text-sm">
          <MetaRow label="ID" value={spore.id} />
          <MetaRow label="Created" value={formatEpochAbsolute(spore.created_at)} />
          <MetaRow label="Updated" value={formatEpochAbsolute(spore.updated_at)} />
          {spore.session_id && (
            <div className="flex items-start justify-between gap-3 py-1.5 border-b border-border last:border-0">
              <span className="shrink-0 text-xs text-muted-foreground">Session</span>
              <button
                className="text-xs text-primary font-mono hover:underline flex items-center gap-1"
                onClick={() => navigate(`/sessions/${spore.session_id}`)}
              >
                {spore.session_id.slice(0, 12)}
                <ExternalLink className="h-3 w-3" />
              </button>
            </div>
          )}
          {spore.curator_id && (
            <MetaRow label="Curator" value={spore.curator_id} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
