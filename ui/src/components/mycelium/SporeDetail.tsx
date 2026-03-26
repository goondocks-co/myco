import { useNavigate } from 'react-router-dom';
import { ArrowLeft, AlertCircle, Loader2, ArrowRight, ExternalLink } from 'lucide-react';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { useSpore } from '../../hooks/use-spores';
import { cn } from '../../lib/cn';
import { formatEpochAgo, formatEpochAbsolute } from '../../lib/format';
import { observationTypeClass, statusClass, formatLabel } from './helpers';

/* ---------- Constants ---------- */

/** Session ID preview length in metadata. */
const SESSION_ID_PREVIEW = 12;

/** Predecessor/successor ID preview length. */
const RESOLUTION_ID_PREVIEW = 8;

/* ---------- Sub-components ---------- */

function TypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold',
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
        'inline-flex items-center rounded-md px-2.5 py-0.5 text-xs font-semibold',
        statusClass(status),
      )}
    >
      {formatLabel(status)}
    </span>
  );
}

function MetaRow({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1.5">
      <span className="shrink-0 font-sans text-xs text-on-surface-variant">{label}</span>
      {children ?? <span className="font-mono text-xs text-on-surface text-right break-all">{value}</span>}
    </div>
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
      <div className="flex h-64 items-center justify-center gap-2 text-on-surface-variant">
        <Loader2 className="h-5 w-5 animate-spin" />
        <span className="font-sans">Loading spore...</span>
      </div>
    );
  }

  if (isError || !spore) {
    return (
      <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
        <AlertCircle className="h-5 w-5" />
        <span className="font-sans text-sm">Spore not found</span>
        <span className="font-sans text-xs text-on-surface-variant">
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
        className="gap-2 text-on-surface-variant"
      >
        <ArrowLeft className="h-4 w-4" />
        Spores
      </Button>

      {/* Header */}
      <div className="flex items-center gap-3 flex-wrap">
        <TypeBadge type={spore.observation_type} />
        <StatusBadge status={spore.status} />
        {spore.importance !== null && (
          <span className="font-sans text-xs text-on-surface-variant">
            Importance: <span className="text-on-surface font-medium">{spore.importance.toFixed(1)}</span>
          </span>
        )}
        <span className="font-sans text-xs text-on-surface-variant ml-auto">
          {formatEpochAgo(spore.created_at)}
        </span>
      </div>

      {/* Content */}
      <Surface level="low" className="p-5">
        <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant mb-2">Observation</div>
        <p className="font-sans text-sm text-on-surface whitespace-pre-wrap">{spore.content}</p>
      </Surface>

      {/* Context */}
      {spore.context && (
        <Surface level="low" className="p-5">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant mb-2">Context</div>
          <p className="font-sans text-sm text-on-surface-variant whitespace-pre-wrap">{spore.context}</p>
        </Surface>
      )}

      {/* Tags */}
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center rounded-full bg-surface-container px-2.5 py-0.5 font-sans text-xs text-on-surface-variant"
            >
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Resolution history */}
      {(spore.predecessor_id || spore.successor_id) && (
        <Surface level="low" className="p-5 space-y-2">
          <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">Resolution History</div>
          {spore.predecessor_id && (
            <div className="flex items-center gap-2 font-sans text-xs text-on-surface-variant">
              <span>Supersedes</span>
              <button
                className="font-mono text-primary hover:underline flex items-center gap-1"
                onClick={() => onNavigateToSpore?.(spore.predecessor_id!)}
              >
                {spore.predecessor_id.slice(0, RESOLUTION_ID_PREVIEW)}
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}
          {spore.successor_id && (
            <div className="flex items-center gap-2 font-sans text-xs text-on-surface-variant">
              <span>Superseded by</span>
              <button
                className="font-mono text-primary hover:underline flex items-center gap-1"
                onClick={() => onNavigateToSpore?.(spore.successor_id!)}
              >
                {spore.successor_id.slice(0, RESOLUTION_ID_PREVIEW)}
                <ArrowRight className="h-3 w-3" />
              </button>
            </div>
          )}
        </Surface>
      )}

      {/* Metadata */}
      <Surface glass className="p-5">
        <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant mb-2">Metadata</div>
        <div className="text-sm">
          <MetaRow label="ID" value={spore.id} />
          <MetaRow label="Created" value={formatEpochAbsolute(spore.created_at)} />
          <MetaRow label="Updated" value={formatEpochAbsolute(spore.updated_at)} />
          {spore.session_id && (
            <MetaRow label="Session">
              <button
                className="font-mono text-xs text-primary hover:underline flex items-center gap-1"
                onClick={() => navigate(`/sessions/${spore.session_id}`)}
              >
                {spore.session_id.slice(0, SESSION_ID_PREVIEW)}
                <ExternalLink className="h-3 w-3" />
              </button>
            </MetaRow>
          )}
          {spore.agent_id && (
            <MetaRow label="Agent" value={spore.agent_id} />
          )}
        </div>
      </Surface>
    </div>
  );
}
