import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { X, ExternalLink, Search } from 'lucide-react';
import type { GraphNode } from '../../hooks/use-graph-canvas';

/* ---------- Constants ---------- */

/** Truncation limit for markdown preview text. */
const MARKDOWN_PREVIEW_LIMIT = 400;

/** Entity type to badge variant mapping. */
const TYPE_BADGE_VARIANT: Record<string, 'default' | 'warning' | 'destructive' | 'secondary'> = {
  concept: 'default',
  component: 'warning',
  bug: 'destructive',
  tool: 'secondary',
  file: 'secondary',
};

/** Entity type to display color class. */
const TYPE_DOT_COLOR: Record<string, string> = {
  concept: 'bg-primary',
  component: 'bg-secondary',
  bug: 'bg-tertiary',
  tool: 'bg-outline',
  file: 'bg-outline',
};

/* ---------- Types ---------- */

interface InspectorProps {
  node: GraphNode | null;
  metadata?: Record<string, string>;
  markdownPreview?: string;
  connectedSpores?: Array<{ id: string; name: string; type: string }>;
  onClose?: () => void;
}

/* ---------- Sub-components ---------- */

function MetadataRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline py-1">
      <span className="font-sans text-xs text-on-surface-variant">{label}</span>
      <span className="font-mono text-xs text-on-surface text-right max-w-[160px] truncate">{value}</span>
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div className="font-sans text-xs font-medium uppercase tracking-widest text-on-surface-variant">
      {children}
    </div>
  );
}

/* ---------- Component ---------- */

export function Inspector({ node, metadata, markdownPreview, connectedSpores, onClose }: InspectorProps) {
  if (!node) return null;

  const typeKey = node.type.toLowerCase();
  const badgeVariant = TYPE_BADGE_VARIANT[typeKey] ?? 'secondary';
  const dotColor = TYPE_DOT_COLOR[typeKey] ?? 'bg-outline';

  const truncatedPreview =
    markdownPreview && markdownPreview.length > MARKDOWN_PREVIEW_LIMIT
      ? markdownPreview.slice(0, MARKDOWN_PREVIEW_LIMIT) + '\u2026'
      : markdownPreview;

  return (
    <Surface glass className="w-[320px] shrink-0 overflow-y-auto max-h-full flex flex-col">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <div className={`h-2 w-2 rounded-full ${dotColor} shrink-0`} />
              <Badge variant={badgeVariant} className="text-[10px] uppercase">
                {node.type}
              </Badge>
            </div>
            <h2 className="font-serif text-lg text-on-surface leading-tight break-words">
              {node.name}
            </h2>
          </div>
          {onClose && (
            <button
              onClick={onClose}
              className="shrink-0 rounded-md p-1 text-on-surface-variant hover:text-on-surface hover:bg-surface-container-high transition-colors"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>

      {/* Divider — tonal shift instead of border */}
      <div className="h-px bg-surface-container-high/50" />

      {/* Metadata table */}
      <div className="px-4 py-3 space-y-0.5">
        <SectionHeader>Metadata</SectionHeader>
        <div className="mt-1.5">
          <MetadataRow label="Type" value={node.type} />
          <MetadataRow label="ID" value={node.id.slice(0, 12) + '\u2026'} />
          {node.depth !== undefined && (
            <MetadataRow label="Depth" value={String(node.depth)} />
          )}
          {metadata &&
            Object.entries(metadata).map(([key, value]) => (
              <MetadataRow key={key} label={key} value={value} />
            ))}
        </div>
      </div>

      {/* Markdown preview */}
      {truncatedPreview && (
        <>
          <div className="h-px bg-surface-container-high/50" />
          <div className="px-4 py-3 space-y-1.5">
            <SectionHeader>Notes</SectionHeader>
            <Surface
              level="lowest"
              className="p-3 font-sans text-xs text-on-surface-variant whitespace-pre-wrap leading-relaxed"
            >
              {truncatedPreview}
            </Surface>
          </div>
        </>
      )}

      {/* Connected spores */}
      {connectedSpores && connectedSpores.length > 0 && (
        <>
          <div className="h-px bg-surface-container-high/50" />
          <div className="px-4 py-3 space-y-1.5">
            <SectionHeader>Connected Spores</SectionHeader>
            <div className="flex flex-wrap gap-1.5">
              {connectedSpores.map((s) => (
                <Badge
                  key={s.id}
                  variant="secondary"
                  className="cursor-pointer text-[10px] hover:bg-surface-container-highest transition-colors"
                >
                  {s.name}
                </Badge>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Action buttons */}
      <div className="h-px bg-surface-container-high/50" />
      <div className="flex gap-2 p-4 pt-3">
        <Button variant="secondary" size="sm" className="flex-1 gap-1.5">
          <ExternalLink className="h-3.5 w-3.5" />
          Open
        </Button>
        <Button variant="secondary" size="sm" className="flex-1 gap-1.5">
          <Search className="h-3.5 w-3.5" />
          Analyze
        </Button>
      </div>
    </Surface>
  );
}
