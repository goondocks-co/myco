import { useNavigate } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { SectionHeader } from '../ui/section-header';

import { X, ArrowRight, ExternalLink } from 'lucide-react';
import type { GraphNode, GraphEdge } from '../../hooks/use-graph-canvas';

/* ---------- Constants ---------- */

/** Truncation limit for markdown preview text. */
const MARKDOWN_PREVIEW_LIMIT = 400;

/** Node type to badge variant mapping. */
const TYPE_BADGE_VARIANT: Record<string, 'default' | 'warning' | 'destructive' | 'secondary'> = {
  concept: 'default',
  component: 'warning',
  bug: 'destructive',
  tool: 'secondary',
  file: 'secondary',
  spore: 'default',
  session: 'warning',
};

/** Node type to display color class. */
const TYPE_DOT_COLOR: Record<string, string> = {
  concept: 'bg-primary',
  component: 'bg-secondary',
  bug: 'bg-tertiary',
  tool: 'bg-outline',
  file: 'bg-outline',
  spore: 'bg-primary',
  session: 'bg-secondary',
};

/* ---------- Types ---------- */

interface Connection {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  edgeLabel: string;
  direction: 'outgoing' | 'incoming';
}

interface InspectorProps {
  node: GraphNode | null;
  edges?: GraphEdge[];
  nodes?: GraphNode[];
  metadata?: Record<string, string>;
  markdownPreview?: string;
  connectedSpores?: Array<{ id: string; name: string; type: string }>;
  onClose?: () => void;
  onNodeSelect?: (node: GraphNode) => void;
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

/* ---------- Component ---------- */

/** Returns the route path for a node, or null if no detail page exists. */
function getNodeRoute(node: GraphNode): string | null {
  if (node.type === 'session') return `/sessions/${node.id}`;
  if (node.type === 'spore') return `/mycelium?tab=spores&spore=${node.id}`;
  return null;
}

export function Inspector({ node, edges, nodes, metadata, markdownPreview, connectedSpores, onClose, onNodeSelect }: InspectorProps) {
  const navigate = useNavigate();
  if (!node) return null;

  const typeKey = node.type.toLowerCase();
  const badgeVariant = TYPE_BADGE_VARIANT[typeKey] ?? 'secondary';
  const dotColor = TYPE_DOT_COLOR[typeKey] ?? 'bg-outline';

  // Build connections list from edges
  const nodeMap = new Map((nodes ?? []).map((n) => [n.id, n]));
  const connections: Connection[] = [];
  for (const edge of edges ?? []) {
    if (edge.source_id === node.id) {
      const target = nodeMap.get(edge.target_id);
      if (target) {
        connections.push({ nodeId: target.id, nodeName: target.name, nodeType: target.type, edgeLabel: edge.label ?? 'connected', direction: 'outgoing' });
      }
    } else if (edge.target_id === node.id) {
      const source = nodeMap.get(edge.source_id);
      if (source) {
        connections.push({ nodeId: source.id, nodeName: source.name, nodeType: source.type, edgeLabel: edge.label ?? 'connected', direction: 'incoming' });
      }
    }
  }

  // Use explicit markdownPreview prop, or fall back to node content (spore/session)
  const previewText = markdownPreview ?? node.content;
  const truncatedPreview =
    previewText && previewText.length > MARKDOWN_PREVIEW_LIMIT
      ? previewText.slice(0, MARKDOWN_PREVIEW_LIMIT) + '\u2026'
      : previewText;

  // Determine the section label based on node type
  const previewLabel = node.type === 'spore' ? 'Observation' : node.type === 'session' ? 'Summary' : 'Notes';

  return (
    <Surface glass className="absolute top-0 right-0 z-20 w-[320px] max-h-full overflow-y-auto flex flex-col shadow-lg border border-outline-variant/15 rounded-md">
      {/* Header */}
      <div className="p-4 pb-3">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-1.5">
              <div className={`h-2 w-2 rounded-full ${dotColor} shrink-0`} />
              <Badge variant={badgeVariant} className="text-[10px] uppercase">
                {node.observation_type ?? node.type}
              </Badge>
            </div>
            <h2 className="font-serif text-lg text-on-surface leading-tight break-words">
              {node.name}
            </h2>
            {getNodeRoute(node) && (
              <button
                onClick={() => navigate(getNodeRoute(node)!)}
                className="inline-flex items-center gap-1 mt-1.5 font-sans text-xs text-on-surface-variant hover:text-primary transition-colors group cursor-pointer"
              >
                <span>View {node.type}</span>
                <ExternalLink className="h-3 w-3 group-hover:translate-x-0.5 transition-transform" />
              </button>
            )}
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
          <MetadataRow label="Type" value={node.observation_type ?? node.type} />
          <MetadataRow label="ID" value={node.id.slice(0, 12) + '\u2026'} />
          {node.status && (
            <MetadataRow label="Status" value={node.status} />
          )}
          {node.created_at != null && (
            <MetadataRow label="Created" value={new Date(node.created_at).toLocaleDateString()} />
          )}
          {node.mention_count != null && node.mention_count > 0 && (
            <MetadataRow label="Mentions" value={String(node.mention_count)} />
          )}
          <MetadataRow label="Connections" value={String(connections.length)} />
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
            <SectionHeader>{previewLabel}</SectionHeader>
            <Surface
              level="lowest"
              className="p-3 font-sans text-xs text-on-surface-variant whitespace-pre-wrap leading-relaxed"
            >
              {truncatedPreview}
            </Surface>
          </div>
        </>
      )}

      {/* Connections */}
      {connections.length > 0 && (
        <>
          <div className="h-px bg-surface-container-high/50" />
          <div className="px-4 py-3 space-y-2">
            <SectionHeader>Connections ({connections.length})</SectionHeader>
            <div className="space-y-1">
              {connections.map((conn, i) => {
                const connTypeKey = conn.nodeType.toLowerCase();
                const connDot = TYPE_DOT_COLOR[connTypeKey] ?? 'bg-outline';
                const targetNode = nodeMap.get(conn.nodeId);
                return (
                  <button
                    key={`${conn.nodeId}-${conn.edgeLabel}-${i}`}
                    className="w-full flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-surface-container-high/50 transition-colors group"
                    onClick={() => targetNode && onNodeSelect?.(targetNode)}
                  >
                    <div className={`h-2 w-2 rounded-full ${connDot} shrink-0`} />
                    <span className="font-sans text-xs text-on-surface truncate flex-1 group-hover:text-primary transition-colors">
                      {conn.nodeName}
                    </span>
                    <ArrowRight className={`h-3 w-3 shrink-0 ${conn.direction === 'incoming' ? 'rotate-180' : ''} text-on-surface-variant/50`} />
                    <span className="font-mono text-[9px] text-on-surface-variant/60 shrink-0 max-w-[80px] truncate">
                      {conn.edgeLabel}
                    </span>
                  </button>
                );
              })}
            </div>
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

    </Surface>
  );
}
