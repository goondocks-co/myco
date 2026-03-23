import { useState } from 'react';
import { AlertCircle, Network, ChevronRight } from 'lucide-react';
import { Button } from '../ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/card';
import { useEntities, useGraph, type EntitySummary, type GraphNode } from '../../hooks/use-spores';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Maximum number of entities shown in the selector before truncation. */
const ENTITY_SELECTOR_LIMIT = 30;

/** Available graph depth options. */
const DEPTH_OPTIONS = [1, 2, 3] as const;
type Depth = (typeof DEPTH_OPTIONS)[number];

/* ---------- Helpers ---------- */

function entityTypeClass(type: string): string {
  switch (type.toLowerCase()) {
    case 'technology': return 'bg-blue-500/15 text-blue-600 border-blue-500/30 dark:text-blue-400';
    case 'concept':    return 'bg-purple-500/15 text-purple-600 border-purple-500/30 dark:text-purple-400';
    case 'person':     return 'bg-green-500/15 text-green-700 border-green-500/30 dark:text-green-400';
    case 'project':    return 'bg-orange-500/15 text-orange-600 border-orange-500/30 dark:text-orange-400';
    case 'file':       return 'bg-muted text-muted-foreground border-border';
    default:           return 'bg-muted text-muted-foreground border-border';
  }
}

function formatLabel(value: string | undefined): string {
  if (!value) return 'Unknown';
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ---------- Sub-components ---------- */

function EntityTypeBadge({ type }: { type: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-semibold',
        entityTypeClass(type),
      )}
    >
      {formatLabel(type)}
    </span>
  );
}

function EntitySelector({
  entities,
  onSelect,
}: {
  entities: EntitySummary[];
  onSelect: (id: string) => void;
}) {
  const visible = entities.slice(0, ENTITY_SELECTOR_LIMIT);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Select an entity to explore its connections:</p>
      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
        {visible.map((entity) => (
          <button
            key={entity.id}
            className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-left text-sm hover:bg-accent/50 transition-colors"
            onClick={() => onSelect(entity.id)}
          >
            <span className="truncate font-medium">{entity.name}</span>
            <div className="flex items-center gap-1.5 shrink-0">
              <EntityTypeBadge type={entity.type} />
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
            </div>
          </button>
        ))}
      </div>
      {entities.length > ENTITY_SELECTOR_LIMIT && (
        <p className="text-xs text-muted-foreground">
          Showing {ENTITY_SELECTOR_LIMIT} of {entities.length} entities
        </p>
      )}
    </div>
  );
}

function ConnectedNode({
  node,
  edgeLabel,
  onSelect,
}: {
  node: GraphNode;
  edgeLabel: string;
  onSelect: (id: string) => void;
}) {
  return (
    <button
      className="flex items-center gap-3 rounded-md border border-border px-3 py-2.5 text-left w-full hover:bg-accent/50 transition-colors"
      onClick={() => onSelect(node.id)}
    >
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm font-medium truncate">{node.name}</span>
          <EntityTypeBadge type={node.type} />
          {node.depth > 1 && (
            <span className="text-xs text-muted-foreground">depth {node.depth}</span>
          )}
        </div>
        <span className="text-xs text-muted-foreground italic">{edgeLabel}</span>
      </div>
      <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
    </button>
  );
}

/* ---------- Component ---------- */

export interface GraphExplorerProps {
  initialEntityId?: string;
}

export function GraphExplorer({ initialEntityId }: GraphExplorerProps) {
  const [centerId, setCenterId] = useState<string | undefined>(initialEntityId);
  const [depth, setDepth] = useState<Depth>(1);

  const { data: entitiesData, isLoading: entitiesLoading, isError: entitiesError } =
    useEntities();

  const { data: graphData, isLoading: graphLoading, isError: graphError } =
    useGraph(centerId, depth);

  const entities = entitiesData?.entities ?? [];
  const hasEntities = entities.length > 0;

  /* Build a lookup for edge labels keyed by target node id */
  const edgeMap = new Map<string, string>();
  if (graphData) {
    for (const edge of graphData.edges) {
      edgeMap.set(edge.target_id, edge.label);
      // also map source → label for undirected display
      if (!edgeMap.has(edge.source_id)) {
        edgeMap.set(edge.source_id, edge.label);
      }
    }
  }

  /* Nodes excluding the center */
  const connectedNodes = graphData
    ? graphData.nodes.filter((n) => n.id !== graphData.center.id)
    : [];

  return (
    <div className="space-y-4">
      {/* Depth controls + back button */}
      {centerId && (
        <div className="flex items-center gap-3 flex-wrap">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground gap-1"
            onClick={() => setCenterId(undefined)}
          >
            ← All entities
          </Button>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-xs text-muted-foreground mr-1">Depth:</span>
            {DEPTH_OPTIONS.map((d) => (
              <Button
                key={d}
                variant={depth === d ? 'default' : 'outline'}
                size="sm"
                className="h-7 w-7 p-0"
                onClick={() => setDepth(d)}
              >
                {d}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Entity selector — shown when no center is selected */}
      {!centerId && (
        <>
          {entitiesLoading && (
            <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <div key={i} className="h-10 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          )}
          {entitiesError && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">Failed to load entities</span>
            </div>
          )}
          {!entitiesLoading && !entitiesError && !hasEntities && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
              <Network className="h-8 w-8 opacity-30" />
              <span className="text-sm">No graph data yet</span>
              <span className="text-xs text-center max-w-xs">
                Run the curator to build the mycelium — entities and their connections will appear here.
              </span>
            </div>
          )}
          {!entitiesLoading && !entitiesError && hasEntities && (
            <EntitySelector entities={entities} onSelect={setCenterId} />
          )}
        </>
      )}

      {/* Graph view — centered on selected entity */}
      {centerId && (
        <>
          {graphLoading && (
            <div className="space-y-2">
              <div className="h-14 animate-pulse rounded-lg bg-muted" />
              {[1, 2, 3].map((i) => (
                <div key={i} className="h-12 animate-pulse rounded-md bg-muted" />
              ))}
            </div>
          )}
          {graphError && (
            <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
              <AlertCircle className="h-5 w-5" />
              <span className="text-sm">Failed to load graph</span>
            </div>
          )}
          {!graphLoading && !graphError && graphData && (
            <div className="space-y-4">
              {/* Center node */}
              <Card>
                <CardHeader className="pb-2">
                  <div className="flex items-center gap-2 flex-wrap">
                    <CardTitle className="text-base">{graphData.center.name}</CardTitle>
                    <EntityTypeBadge type={graphData.center.type} />
                  </div>
                </CardHeader>
                {connectedNodes.length === 0 && (
                  <CardContent>
                    <p className="text-sm text-muted-foreground">No connections found at depth {depth}.</p>
                  </CardContent>
                )}
              </Card>

              {/* Connected nodes */}
              {connectedNodes.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                    {connectedNodes.length} connection{connectedNodes.length !== 1 ? 's' : ''}
                  </p>
                  {connectedNodes.map((node) => (
                    <ConnectedNode
                      key={node.id}
                      node={node}
                      edgeLabel={edgeMap.get(node.id) ?? 'related to'}
                      onSelect={setCenterId}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
