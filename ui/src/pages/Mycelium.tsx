import { useState, useMemo, useCallback } from 'react';
import { GraphCanvas } from '../components/mycelium/GraphCanvas';
import { EntityFilter } from '../components/mycelium/EntityFilter';
import { Inspector } from '../components/mycelium/Inspector';
import { SporeList } from '../components/mycelium/SporeList';
import { SporeDetail } from '../components/mycelium/SporeDetail';
import { DigestView } from '../components/mycelium/DigestView';
import { useEntities, useGraph } from '../hooks/use-spores';
import type { GraphNode } from '../hooks/use-graph-canvas';
import type { SporeSummary } from '../hooks/use-spores';
import { cn } from '../lib/cn';

/* ---------- Constants ---------- */

const ALL_ENTITY_TYPES = new Set(['concept', 'component', 'bug', 'tool', 'file', 'other']);

/** Default graph traversal depth for full-graph mode. */
const DEFAULT_GRAPH_DEPTH = 2;

/* ---------- Types ---------- */

type ActiveTab = 'graph' | 'spores' | 'digest';

/* ---------- Sub-components ---------- */

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-4 py-2 text-sm font-sans font-medium transition-colors rounded-t-md',
        active
          ? 'bg-surface-container text-on-surface'
          : 'text-on-surface-variant hover:text-on-surface hover:bg-surface-container-low',
      )}
    >
      {children}
    </button>
  );
}

/* ---------- Graph Tab ---------- */

function GraphTab() {
  const [enabledTypes, setEnabledTypes] = useState<Set<string>>(new Set(ALL_ENTITY_TYPES));
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);

  const { data: entitiesData } = useEntities();
  const entities = entitiesData?.entities ?? [];

  /* Pick the first entity as the center for the graph if available */
  const centerId = entities.length > 0 ? entities[0]?.id : undefined;
  const { data: graphData } = useGraph(centerId, DEFAULT_GRAPH_DEPTH);

  /* Build entity type counts */
  const entityCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const e of entities) {
      const type = e.type.toLowerCase();
      const bucket = ALL_ENTITY_TYPES.has(type) ? type : 'other';
      counts[bucket] = (counts[bucket] ?? 0) + 1;
    }
    return counts;
  }, [entities]);

  /* Filter nodes for the graph */
  const filteredNodes = useMemo(() => {
    const nodes = graphData?.nodes ?? [];
    const lowerQuery = searchQuery.toLowerCase();
    return nodes.filter((n) => {
      const type = n.type.toLowerCase();
      const bucket = ALL_ENTITY_TYPES.has(type) ? type : 'other';
      if (!enabledTypes.has(bucket)) return false;
      if (lowerQuery && !n.name.toLowerCase().includes(lowerQuery)) return false;
      return true;
    });
  }, [graphData?.nodes, enabledTypes, searchQuery]);

  /* Edges filtered to only include visible nodes */
  const filteredEdges = useMemo(() => {
    const edges = graphData?.edges ?? [];
    const visibleIds = new Set(filteredNodes.map((n) => n.id));
    return edges.filter((e) => visibleIds.has(e.source_id) && visibleIds.has(e.target_id));
  }, [graphData?.edges, filteredNodes]);

  const handleToggleType = useCallback((type: string) => {
    setEnabledTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  const handleNodeSelect = useCallback((node: GraphNode | null) => {
    setSelectedNode(node);
  }, []);

  return (
    <div className="flex gap-3 h-[calc(100vh-180px)]">
      <EntityFilter
        entityCounts={entityCounts}
        enabledTypes={enabledTypes}
        onToggleType={handleToggleType}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      <GraphCanvas
        nodes={filteredNodes}
        edges={filteredEdges}
        onNodeSelect={handleNodeSelect}
        selectedNode={selectedNode}
      />
      <Inspector
        node={selectedNode}
        edges={filteredEdges}
        nodes={filteredNodes}
        onClose={() => setSelectedNode(null)}
        onNodeSelect={(n) => setSelectedNode(n)}
      />
    </div>
  );
}

/* ---------- Component ---------- */

export default function Mycelium() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('graph');
  const [selectedSpore, setSelectedSpore] = useState<SporeSummary | null>(null);

  function handleSelectSpore(spore: SporeSummary) {
    setSelectedSpore(spore);
  }

  function handleBackToList() {
    setSelectedSpore(null);
  }

  function handleNavigateToSpore(id: string) {
    setSelectedSpore({ id } as SporeSummary);
  }

  return (
    <div className="p-6 space-y-4">
      <div>
        <h1 className="font-serif text-2xl text-on-surface">Mycelium</h1>
        <p className="font-sans text-sm text-on-surface-variant mt-1">
          Derived intelligence — spores, entity graph, and synthesized context.
        </p>
      </div>

      {/* Tab bar */}
      <div className="flex gap-0 bg-surface-container-low rounded-t-md">
        <TabButton active={activeTab === 'graph'} onClick={() => setActiveTab('graph')}>
          Graph
        </TabButton>
        <TabButton active={activeTab === 'spores'} onClick={() => { setActiveTab('spores'); setSelectedSpore(null); }}>
          Spores
        </TabButton>
        <TabButton active={activeTab === 'digest'} onClick={() => setActiveTab('digest')}>
          Digest
        </TabButton>
      </div>

      {/* Tab content */}
      {activeTab === 'graph' && <GraphTab />}

      {activeTab === 'spores' && (
        selectedSpore ? (
          <SporeDetail
            id={selectedSpore.id}
            onBack={handleBackToList}
            onNavigateToSpore={handleNavigateToSpore}
          />
        ) : (
          <SporeList
            onSelectSpore={handleSelectSpore}
          />
        )
      )}

      {activeTab === 'digest' && <DigestView />}
    </div>
  );
}
