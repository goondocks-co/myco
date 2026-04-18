import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { GraphCanvas } from '../components/mycelium/GraphCanvas';
import { Inspector } from '../components/mycelium/Inspector';
import { SporeList } from '../components/mycelium/SporeList';
import { SporeDetail } from '../components/mycelium/SporeDetail';
import { PageHeader } from '../components/ui/page-header';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { useFullGraph, useGraph, useGraphSeeds } from '../hooks/use-spores';
import { Network, Target, Info, Search } from 'lucide-react';
import type { GraphNode } from '../hooks/use-graph-canvas';
import type { SporeSummary } from '../hooks/use-spores';
import type { Tab } from '../components/ui/tab-switcher';
import { cn } from '../lib/cn';
import { formatGraphLabel } from '../lib/graph-labels';

/* ---------- Constants ---------- */

const ALL_NODE_TYPES = new Set(['concept', 'component', 'bug', 'tool', 'file', 'spore', 'session', 'other']);

/** Maximum nodes before suggesting focus mode */
const LARGE_GRAPH_THRESHOLD = 200;

const INSPECTOR_OFFSET_CLASS = 'right-[332px]';
const SEARCH_MATCH_LIMIT = 6;
const FOCUS_TRAIL_LIMIT = 3;
const GRAPH_CANVAS_HEIGHT_CLASS = 'h-[calc(100vh-285px)]';

/* ---------- Types ---------- */

type ActiveTab = 'graph' | 'spores';
type ViewMode = 'global' | 'focus';

/** Tab definitions for the PageHeader TabSwitcher. */
const MYCELIUM_TABS: Tab[] = [
  { id: 'graph', label: 'Graph' },
  { id: 'spores', label: 'Spores' },
];

/* ---------- URL state helpers ---------- */

/** URL search param keys for persistent navigation state. */
const PARAM_TAB = 'tab';
const PARAM_SPORE = 'spore';

/** Valid tab values for URL parsing. */
const VALID_TABS = new Set<ActiveTab>(['graph', 'spores']);

/** Read initial state from URL search params. */
function readUrlState(): { tab: ActiveTab; sporeId?: string } {
  const params = new URLSearchParams(window.location.search);
  const rawTab = params.get(PARAM_TAB);
  const sporeId = params.get(PARAM_SPORE) ?? undefined;
  // If a spore ID is present, force the spores tab so the detail view renders
  const tab: ActiveTab = sporeId
    ? 'spores'
    : rawTab && VALID_TABS.has(rawTab as ActiveTab)
      ? (rawTab as ActiveTab)
      : 'graph';
  return { tab, sporeId };
}

/** Write navigation state to URL search params. */
function writeUrlState(tab: ActiveTab, sporeId?: string): void {
  const params = new URLSearchParams();
  if (tab !== 'graph') params.set(PARAM_TAB, tab);
  if (sporeId) params.set(PARAM_SPORE, sporeId);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.pushState(null, '', url);
}

function extractGraphNodes(graphData: { center?: GraphNode; nodes?: GraphNode[] } | undefined): GraphNode[] {
  if (!graphData) return [];

  const nodes: GraphNode[] = [];
  if ('center' in graphData && graphData.center) {
    nodes.push(graphData.center);
  }
  if (graphData.nodes) {
    nodes.push(...graphData.nodes);
  }
  return nodes;
}

/* ---------- Graph Tab ---------- */

function GraphTab({ onNavigateToSpore }: { onNavigateToSpore?: (id: string) => void }) {
  const [viewMode, setViewMode] = useState<ViewMode>('focus');
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusDepth, setFocusDepth] = useState<number>(2);
  const [enabledTypes] = useState<Set<string>>(new Set(ALL_NODE_TYPES));
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [focusTrail, setFocusTrail] = useState<GraphNode[]>([]);

  const { data: seedData, isLoading: seedLoading } = useGraphSeeds();
  const shouldFetchFocusGraph = viewMode === 'focus' && focusId !== null;
  const shouldFetchFullGraph = viewMode === 'global';
  const { data: fullGraphData, isLoading: fullGraphLoading } = useFullGraph(shouldFetchFullGraph || searchQuery.length > 0);
  const { data: focusGraphData, isLoading: focusGraphLoading } = useGraph(
    focusId ?? undefined,
    focusDepth,
    shouldFetchFocusGraph,
  );
  const shouldFetchInspectorGraph = selectedNode !== null && selectedNode.id !== focusId;
  const { data: inspectorGraphData, isLoading: inspectorGraphLoading } = useGraph(
    selectedNode?.id,
    1,
    shouldFetchInspectorGraph,
  );

  const graphData = viewMode === 'global' ? fullGraphData : focusGraphData;
  const isLoading = viewMode === 'global'
    ? fullGraphLoading
    : seedLoading || (shouldFetchFocusGraph && focusGraphLoading);
  const isLargeGraph = (fullGraphData?.nodes?.length ?? 0) > LARGE_GRAPH_THRESHOLD;

  useEffect(() => {
    if (!focusId && seedData?.recommended_id) {
      const recommended = seedData.seeds.find((seed) => seed.id === seedData.recommended_id) ?? seedData.seeds[0];
      if (recommended) {
        setFocusId(recommended.id);
        setSelectedNode(recommended);
        setFocusTrail([recommended]);
      }
    }
  }, [focusId, seedData]);

  useEffect(() => {
    if (viewMode === 'focus' && focusId && focusGraphData?.center?.id === focusId) {
      setSelectedNode(focusGraphData.center);
      setFocusTrail((prev) => {
        if (prev.length === 0) return [focusGraphData.center];
        const last = prev[prev.length - 1];
        if (last?.id === focusGraphData.center.id) {
          return [...prev.slice(0, -1), focusGraphData.center];
        }
        return prev;
      });
    }
  }, [focusId, focusGraphData, viewMode]);

  const inspectorNeighborhood = selectedNode?.id === focusId ? focusGraphData : inspectorGraphData;
  const isInspectorLoading = selectedNode?.id === focusId ? focusGraphLoading : inspectorGraphLoading;
  const inspectorNodes = useMemo(() => extractGraphNodes(inspectorNeighborhood), [inspectorNeighborhood]);
  const inspectorEdges = inspectorNeighborhood?.edges ?? [];

  const allGraphNodes = useMemo(() => extractGraphNodes(graphData), [graphData]);

  const filteredNodes = useMemo(() => {
    return allGraphNodes.filter((node) => {
      const type = node.type.toLowerCase();
      const bucket = ALL_NODE_TYPES.has(type) ? type : 'other';
      if (!enabledTypes.has(bucket)) return false;
      return true;
    });
  }, [allGraphNodes, enabledTypes]);

  const filteredEdges = useMemo(() => {
    const edges = graphData?.edges ?? [];
    const visibleIds = new Set(filteredNodes.map((node) => node.id));
    return edges.filter((edge) => visibleIds.has(edge.source_id) && visibleIds.has(edge.target_id));
  }, [graphData?.edges, filteredNodes]);

  const handleNodeSelect = useCallback((node: GraphNode | null, source: 'canvas' | 'inspector' = 'canvas') => {
    setSelectedNode(node);
    if (!node) return;

    if (viewMode === 'focus') {
      setFocusId((prev) => {
        if (prev === node.id) return prev;
        setFocusTrail((trail) => {
          const next = [...trail, node];
          return next.slice(-FOCUS_TRAIL_LIMIT);
        });
        return node.id;
      });
      return;
    }

    if (source === 'inspector') {
      setFocusId(node.id);
      setViewMode('focus');
    }
  }, [viewMode]);

  const handleShowOverview = useCallback(() => {
    setViewMode('global');
  }, []);

  const handleShowFocus = useCallback(() => {
    if (!focusId && selectedNode) {
      setFocusTrail([selectedNode]);
      setFocusId(selectedNode.id);
    }
    setViewMode('focus');
  }, [focusId, selectedNode]);

  const handleTrailSelect = useCallback((trailNode: GraphNode) => {
    setFocusTrail((trail) => {
      const index = trail.findIndex((entry) => entry.id === trailNode.id);
      return index >= 0 ? trail.slice(0, index + 1) : trail;
    });
    setFocusId(trailNode.id);
    setSelectedNode(trailNode);
    setViewMode('focus');
  }, []);

  const handleTrailBack = useCallback(() => {
    setFocusTrail((trail) => {
      if (trail.length <= 1) return trail;
      const next = trail.slice(0, -1);
      const previous = next[next.length - 1];
      if (previous) {
        setFocusId(previous.id);
        setSelectedNode(previous);
        setViewMode('focus');
      }
      return next;
    });
  }, []);

  const searchCorpus = useMemo(() => {
    const fullGraphNodes = fullGraphData?.nodes ?? [];
    return fullGraphNodes.length > 0 ? fullGraphNodes : allGraphNodes;
  }, [fullGraphData?.nodes, allGraphNodes]);
  const searchMatches = searchQuery
    ? searchCorpus
        .filter((node, index, arr) => arr.findIndex((candidate) => candidate.id === node.id) === index)
        .filter((node) => formatGraphLabel(node.name).toLowerCase().includes(searchQuery.toLowerCase()))
        .slice(0, SEARCH_MATCH_LIMIT)
    : [];

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-outline-variant/20 bg-surface-container/72 px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[260px] flex-1 max-w-[420px]">
            <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-on-surface-variant/60" />
            <Input
              placeholder="Find a node or idea..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-9 pl-9"
            />
          </div>

          <div className="flex rounded-lg border border-outline-variant/10 bg-surface-container-high p-1 shadow-sm">
            <Button
              variant="ghost"
              size="sm"
              className={cn(
                'h-8 px-3 gap-1.5 transition-all',
                viewMode === 'global' ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface',
              )}
              onClick={handleShowOverview}
            >
              <Network className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Overview</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!focusId && !selectedNode}
              className={cn(
                'h-8 px-3 gap-1.5 transition-all',
                viewMode === 'focus' ? 'bg-surface-container-lowest text-primary shadow-sm' : 'text-on-surface-variant hover:text-on-surface',
                !focusId && !selectedNode && 'cursor-not-allowed opacity-50',
              )}
              onClick={handleShowFocus}
            >
              <Target className="h-3.5 w-3.5" />
              <span className="text-xs font-medium">Focus</span>
            </Button>
          </div>

          {viewMode === 'focus' && (
            <div className="flex items-center gap-1 rounded-lg border border-outline-variant/10 bg-surface-container-high p-1 shadow-sm">
              <span className="px-2 font-mono text-[10px] uppercase tracking-wider text-on-surface-variant">Depth</span>
              {[1, 2, 3].map((depth) => (
                <Button
                  key={depth}
                  variant="ghost"
                  size="sm"
                  className={cn(
                    'h-7 min-w-7 rounded-md border px-2 font-mono text-[10px] transition-all',
                    focusDepth === depth
                      ? 'border-primary/40 bg-primary/15 text-primary shadow-sm font-bold'
                      : 'border-transparent text-on-surface-variant hover:border-outline-variant/20 hover:text-on-surface',
                  )}
                  onClick={() => setFocusDepth(depth)}
                >
                  {depth}
                </Button>
              ))}
            </div>
          )}
        </div>

        {searchMatches.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-2 pt-1">
            <span className="text-[11px] uppercase tracking-[0.16em] text-on-surface-variant">Jump To</span>
            {searchMatches.map((match) => (
              <button
                key={match.id}
                type="button"
                onClick={() => handleNodeSelect(match, 'inspector')}
                className={cn(
                  'max-w-[220px] truncate rounded-full border px-3 py-1 text-[11px] transition-colors',
                  selectedNode?.id === match.id
                    ? 'border-primary/40 bg-primary/10 text-on-surface'
                    : 'border-outline-variant/20 bg-surface-container-low/50 text-on-surface-variant hover:text-on-surface',
                )}
                title={formatGraphLabel(match.name)}
              >
                {formatGraphLabel(match.name)}
              </button>
            ))}
          </div>
        )}

        {searchQuery && searchMatches.length === 0 && fullGraphData && (
          <div className="mt-3 border-t border-outline-variant/10 pt-3 text-sm text-on-surface-variant">
            No graph nodes matched `"{searchQuery}"`.
          </div>
        )}

        {focusTrail.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-outline-variant/10 pt-3">
            <span className="text-[11px] uppercase tracking-[0.16em] text-on-surface-variant">Trail</span>
            {focusTrail.length > 1 && (
              <Button variant="ghost" size="sm" className="h-7 shrink-0 px-2 text-[10px]" onClick={handleTrailBack}>
                Back
              </Button>
            )}
            {focusTrail.map((trailNode) => (
              <button
                key={trailNode.id}
                type="button"
                onClick={() => handleTrailSelect(trailNode)}
                className={cn(
                  'max-w-[180px] truncate rounded-full border px-3 py-1 text-[11px] transition-colors',
                  focusId === trailNode.id ? 'border-primary/40 bg-primary/10 text-on-surface' : 'border-outline-variant/20 bg-surface-container-low/50 text-on-surface-variant hover:text-on-surface',
                )}
                title={formatGraphLabel(trailNode.name)}
              >
                {formatGraphLabel(trailNode.name)}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={cn('relative', GRAPH_CANVAS_HEIGHT_CLASS)}>
        {isLoading && (
        <div className="absolute inset-0 z-30 flex items-center justify-center rounded-md bg-surface-container-lowest/50 backdrop-blur-[2px] transition-opacity">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <span className="text-xs font-mono animate-pulse text-on-surface-variant">
              Cultivating {viewMode} graph...
            </span>
          </div>
        </div>
      )}

      <div className={cn('absolute inset-y-3 left-3', selectedNode ? INSPECTOR_OFFSET_CLASS : 'right-3')}>
        <GraphCanvas
          nodes={filteredNodes}
          edges={filteredEdges}
          onNodeSelect={handleNodeSelect}
          selectedNode={selectedNode}
          centerId={viewMode === 'focus' ? focusId : null}
          isLoading={isLoading}
        />
      </div>

      {viewMode === 'global' && isLargeGraph && (
        <div className={cn('absolute bottom-3 left-3 z-10 flex max-w-[280px] flex-col items-start gap-2 rounded-lg border border-warning/20 bg-warning-container/80 p-3 text-on-warning-container shadow-lg backdrop-blur-sm', selectedNode ? INSPECTOR_OFFSET_CLASS : 'right-3')}>
          <div className="flex items-center gap-2">
            <Info className="h-4 w-4 shrink-0 text-warning" />
            <span className="text-[11px] font-semibold uppercase tracking-wider">Overview Snapshot</span>
          </div>
          <p className="text-[11px] leading-relaxed text-on-warning-container/80">
            This overview still contains {fullGraphData?.nodes?.length} nodes. Use Focus mode for navigation and step through connections from the drawer.
          </p>
          <Button variant="destructive" size="sm" className="mt-1 h-7 w-full px-3 text-[10px]" onClick={handleShowFocus}>
            Return to Focus
          </Button>
        </div>
      )}

      <Inspector
        node={selectedNode}
        edges={inspectorEdges}
        nodes={inspectorNodes}
        onClose={() => setSelectedNode(null)}
        onNodeSelect={handleNodeSelect}
        onNavigateToSpore={onNavigateToSpore}
        isConnectionsLoading={isInspectorLoading}
      />
      </div>
    </div>
  );
}


/* ---------- Component ---------- */

export default function Mycelium() {
  const location = useLocation();
  const initial = readUrlState();
  const [activeTab, setActiveTab] = useState<ActiveTab>(initial.tab);
  const [selectedSpore, setSelectedSpore] = useState<SporeSummary | null>(
    initial.sporeId ? { id: initial.sporeId } as SporeSummary : null,
  );
  const hasMounted = useRef(false);
  const skipNextPush = useRef(false);

  // Push URL whenever state changes (skip on mount and popstate)
  useEffect(() => {
    if (!hasMounted.current) { hasMounted.current = true; return; }
    if (skipNextPush.current) { skipNextPush.current = false; return; }
    writeUrlState(activeTab, selectedSpore?.id);
  }, [activeTab, selectedSpore?.id]);

  // Sync state from URL when navigation updates search params.
  useEffect(() => {
    skipNextPush.current = true;
    const state = readUrlState();
    setActiveTab(state.tab);
    setSelectedSpore(state.sporeId ? { id: state.sporeId } as SporeSummary : null);
  }, [location.search, location.key]);

  function handleSelectSpore(spore: SporeSummary) {
    setSelectedSpore(spore);
  }

  function handleBackToList() {
    setSelectedSpore(null);
  }

  function handleNavigateToSpore(id: string) {
    setSelectedSpore({ id } as SporeSummary);
  }

  function handleTabChange(tab: ActiveTab) {
    setActiveTab(tab);
    if (tab !== 'spores') setSelectedSpore(null);
  }

  return (
    <div className="p-6 space-y-4">
      <PageHeader
        title="Mycelium"
        subtitle="Derived intelligence — spores, entity graph, and synthesized context."
        tabs={MYCELIUM_TABS}
        activeTab={activeTab}
        onTabChange={(tabId) => handleTabChange(tabId as ActiveTab)}
      />

      {/* Tab content */}
      {activeTab === 'graph' && <GraphTab onNavigateToSpore={(id) => {
        setActiveTab('spores');
        setSelectedSpore({ id } as SporeSummary);
      }} />}

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
    </div>
  );
}
