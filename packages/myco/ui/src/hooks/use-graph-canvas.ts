import { useEffect, useRef, useCallback, useMemo } from 'react';
import cytoscape, { type Core, type ElementDefinition, type NodeSingular, type StylesheetJson } from 'cytoscape';
import { formatGraphLabel } from '../lib/graph-labels';

/* ---------- Graph palette ---------- */

const PALETTE = {
  sage: '#abcfb8',
  ochre: '#edbf7f',
  terracotta: '#ffb4a1',
  neutral: '#8b928c',
  dimNeutral: '#6e7370',
  onSurface: '#e5e2e1',
  surface: '#111111',
} as const;

/* ---------- Constants ---------- */

/** Node color by entity type — sage for concept, ochre for component, terracotta for bug, gray for tool/file. */
const NODE_COLORS: Record<string, string> = {
  concept: PALETTE.sage,
  component: PALETTE.ochre,
  bug: PALETTE.terracotta,
  tool: PALETTE.neutral,
  file: PALETTE.neutral,
  spore: PALETTE.sage,
  session: PALETTE.ochre,
  other: PALETTE.dimNeutral,
};
const DEFAULT_NODE_COLOR = PALETTE.dimNeutral;

/** Minimum node size (px) — nodes with 0–1 connections. */
const NODE_SIZE_MIN = 24;

/** Maximum node size (px) — most-connected nodes. */
const NODE_SIZE_MAX = 60;

/** Connection count that maps to maximum node size. */
const NODE_SIZE_DEGREE_CAP = 12;

/** Font size for node labels (px). */
const NODE_LABEL_FONT_SIZE = 10;

/** Vertical margin between node and label (px). */
const NODE_LABEL_MARGIN_Y = 8;

/** Edge width (px). */
const EDGE_WIDTH = 1.5;

/** Edge line opacity (default). */
const EDGE_OPACITY = 0.25;

/** Edge opacity when a node is selected (connected edges). */
const EDGE_ACTIVE_OPACITY = 0.7;

/** Edge label font size (px). */
const EDGE_LABEL_FONT_SIZE = 9;

/** Arrow scale for directed edges. */
const ARROW_SCALE = 0.7;

/** Selected node border width (px) — creates visible glow ring. */
const SELECTED_BORDER_WIDTH = 4;

/** Selected node border opacity. */
const SELECTED_BORDER_OPACITY = 0.6;

/** COSE layout: node repulsion force. */
const COSE_NODE_REPULSION = 10000;

/** COSE layout: ideal edge length (px). */
const COSE_IDEAL_EDGE_LENGTH = 120;

/** COSE layout: gravity pull toward center. */
const COSE_GRAVITY = 0.2;

/** COSE layout: animation duration (ms). */
const COSE_ANIMATION_DURATION = 600;

/** Focused layout animation duration (ms). */
const FOCUS_ANIMATION_DURATION = 300;

/** Minimum zoom we allow after focusing a neighborhood. */
const FOCUS_MIN_ZOOM = 0.95;

/** Spacing factor for concentric focus layout. */
const FOCUS_SPACING_FACTOR = 1.2;

/** Fit padding (px) used by resetView. */
const FIT_PADDING = 50;

/** Label truncation length for long node names. */
const NODE_LABEL_MAX_LENGTH = 20;

/** Display labels for node types. */
const NODE_TYPE_LABELS: Record<string, string> = {
  concept: 'Concept',
  component: 'Component',
  bug: 'Bug',
  tool: 'Tool',
  file: 'File',
  spore: 'Spore',
  session: 'Session',
  other: 'Other',
};

/* ---------- Types ---------- */

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  depth?: number;
  // Extended fields for Inspector
  status?: string;
  created_at?: number;
  content?: string;
  properties?: string;
  mention_count?: number;
  observation_type?: string;
}

export interface GraphEdge {
  source_id: string;
  target_id: string;
  label?: string;
  weight?: number;
}

interface UseGraphCanvasOptions {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeSelect?: (node: GraphNode | null) => void;
  centerId?: string | null;
  centerNodeType?: string | null;
  selectedNodeId?: string | null;
}

/* ---------- Helpers ---------- */

/** Compute node size based on its degree (connection count). */
function nodeSizeFromDegree(degree: number, isCenter: boolean): number {
  if (isCenter) return NODE_SIZE_MAX * 1.2;
  const t = Math.min(degree / NODE_SIZE_DEGREE_CAP, 1);
  return NODE_SIZE_MIN + t * (NODE_SIZE_MAX - NODE_SIZE_MIN);
}

/** Truncate label for display. */
function truncateLabel(name: string): string {
  const formatted = formatGraphLabel(name);
  if (formatted.length <= NODE_LABEL_MAX_LENGTH) return formatted;
  return formatted.slice(0, NODE_LABEL_MAX_LENGTH - 1) + '\u2026';
}

/** Get node color for a given type. */
function nodeColor(type: string): string {
  return NODE_COLORS[type?.toLowerCase()] ?? DEFAULT_NODE_COLOR;
}

function stableAngle(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash << 5) - hash + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

/* ---------- Hook ---------- */

function clearGraphSelection(cy: Core): void {
  cy.elements().removeClass('faded');
  cy.elements().unselect();
  cy.edges().style({
    'line-opacity': EDGE_OPACITY,
    'text-opacity': 0,
    width: EDGE_WIDTH,
  });
}

function applyGraphSelection(cy: Core, selectedNodeId: string | null): void {
  if (!selectedNodeId) {
    clearGraphSelection(cy);
    return;
  }

  const node = cy.$id(selectedNodeId);
  if (node.length === 0) {
    clearGraphSelection(cy);
    return;
  }

  clearGraphSelection(cy);
  node.select();
  const neighborhood = node.closedNeighborhood();
  cy.elements().not(neighborhood).addClass('faded');
  node.connectedEdges().style({
    'line-opacity': EDGE_ACTIVE_OPACITY,
    'text-opacity': 0,
    width: 2,
  });
}

export function useGraphCanvas({ nodes, edges, onNodeSelect, centerId, centerNodeType, selectedNodeId }: UseGraphCanvasOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const prevCenterIdRef = useRef<string | null>(null);
  const onNodeSelectRef = useRef(onNodeSelect);
  onNodeSelectRef.current = onNodeSelect;

  const nodeMap = useMemo(() => new Map<string, GraphNode>(nodes.map((n) => [n.id, n])), [nodes]);

  const degreeMap = useMemo(() => {
    const next = new Map<string, number>();
    for (const n of nodes) next.set(n.id, 0);
    for (const e of edges) {
      next.set(e.source_id, (next.get(e.source_id) ?? 0) + 1);
      next.set(e.target_id, (next.get(e.target_id) ?? 0) + 1);
    }
    return next;
  }, [nodes, edges]);

  const style = useMemo<StylesheetJson>(() => ([
    {
      selector: 'node',
      style: {
        label: 'data(label)',
        'background-color': (ele: NodeSingular) => nodeColor(ele.data('type')),
        'background-opacity': 0.9,
        color: PALETTE.onSurface,
        'font-size': NODE_LABEL_FONT_SIZE,
        'font-family': 'Inter, system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-margin-y': NODE_LABEL_MARGIN_Y,
        'text-outline-color': PALETTE.surface,
        'text-outline-width': 2,
        'text-outline-opacity': 0.8,
        'text-wrap': 'wrap',
        'text-max-width': '120px',
        width: 'data(nodeSize)',
        height: 'data(nodeSize)',
        'border-width': 0,
        'border-color': PALETTE.sage,
        'border-opacity': 0,
        'overlay-opacity': 0,
      },
    },
    {
      selector: 'node.center',
      style: {
        'border-width': 2,
        'border-color': PALETTE.onSurface,
        'border-opacity': 0.4,
        'text-outline-color': PALETTE.surface,
        'text-outline-width': 3,
        'font-weight': 'bold',
      },
    },
    {
      selector: 'node:active',
      style: {
        'overlay-opacity': 0.08,
        'overlay-color': PALETTE.sage,
      },
    },
    {
      selector: 'node:selected',
      style: {
        'border-width': SELECTED_BORDER_WIDTH,
        'border-color': (ele: NodeSingular) => nodeColor(ele.data('type')),
        'border-opacity': SELECTED_BORDER_OPACITY,
        'background-opacity': 1,
      },
    },
    {
      selector: 'edge',
      style: {
        width: EDGE_WIDTH,
        'line-color': PALETTE.neutral,
        'line-opacity': EDGE_OPACITY,
        'curve-style': 'unbundled-bezier',
        'control-point-distances': [40],
        'control-point-weights': [0.5],
        'target-arrow-shape': 'triangle',
        'target-arrow-color': PALETTE.neutral,
        'arrow-scale': ARROW_SCALE,
        label: 'data(label)',
        'font-size': EDGE_LABEL_FONT_SIZE,
        'font-family': 'Inter, system-ui, sans-serif',
        color: PALETTE.neutral,
        'text-opacity': 0,
        'text-rotation': 'autorotate',
        'text-margin-y': -8,
        'text-outline-color': PALETTE.surface,
        'text-outline-width': 2,
        'text-outline-opacity': 0.7,
      },
    },
    {
      selector: 'edge:active',
      style: {
        'text-opacity': 1,
        'line-opacity': EDGE_ACTIVE_OPACITY,
      },
    },
    {
      selector: 'node.faded',
      style: { opacity: 0.3 },
    },
    {
      selector: 'edge.faded',
      style: { opacity: 0.1 },
    },
  ]), []);

  const buildElements = useCallback((existingPositions?: Map<string, { x: number; y: number }>): ElementDefinition[] => {
    const rect = containerRef.current?.getBoundingClientRect();
    const fallbackCenter = {
      x: rect ? rect.width / 2 : 0,
      y: rect ? rect.height / 2 : 0,
    };

    return [
      ...nodes.map((n) => {
        const typeLabel = NODE_TYPE_LABELS[n.type?.toLowerCase()] ?? NODE_TYPE_LABELS.other;
        const isCenter = n.id === centerId;
        let position = existingPositions?.get(n.id);

        if (!position) {
          const connectedEdge = edges.find((edge) => edge.source_id === n.id || edge.target_id === n.id);
          const anchorId = connectedEdge
            ? (connectedEdge.source_id === n.id ? connectedEdge.target_id : connectedEdge.source_id)
            : centerId;
          const anchor = anchorId ? existingPositions?.get(anchorId) ?? fallbackCenter : fallbackCenter;
          const angle = (stableAngle(n.id) * Math.PI) / 180;
          const radius = anchorId === centerId ? 150 : 110;
          position = {
            x: anchor.x + Math.cos(angle) * radius,
            y: anchor.y + Math.sin(angle) * radius,
          };
        }

        return {
          data: {
            id: n.id,
            label: `${truncateLabel(n.name)}\n${typeLabel}`,
            fullLabel: n.name,
            type: n.type,
            isCenter,
            degree: degreeMap.get(n.id) ?? 0,
            nodeSize: nodeSizeFromDegree(degreeMap.get(n.id) ?? 0, isCenter),
          },
          position,
          classes: isCenter ? 'center' : '',
        };
      }),
      ...edges.map((e, i) => ({
        data: {
          id: `edge-${i}`,
          source: e.source_id,
          target: e.target_id,
          label: e.label ?? '',
          weight: e.weight ?? 1,
        },
      })),
    ];
  }, [centerId, degreeMap, edges, nodes]);

  const runLayout = useCallback((cy: Core, forceRecenter: boolean) => {
    if (!forceRecenter) {
      cy.resize();
      applyGraphSelection(cy, selectedNodeId ?? null);
      return;
    }

    const layout = centerId && centerNodeType === 'session'
      ? cy.layout({
          name: 'cose',
          animate: true,
          animationDuration: COSE_ANIMATION_DURATION,
          nodeRepulsion: () => COSE_NODE_REPULSION * 1.5,
          idealEdgeLength: () => COSE_IDEAL_EDGE_LENGTH * 1.35,
          gravity: COSE_GRAVITY * 0.75,
          nodeDimensionsIncludeLabels: true,
          fit: true,
          padding: FIT_PADDING * 1.2,
          randomize: false,
        })
      : centerId
      ? cy.layout({
          name: 'concentric',
          animate: true,
          animationDuration: FOCUS_ANIMATION_DURATION,
          fit: true,
          padding: FIT_PADDING,
          spacingFactor: FOCUS_SPACING_FACTOR,
          avoidOverlap: true,
          concentric: (node) => {
            if (node.id() === centerId) return 3;
            const neighborhood = node.closedNeighborhood();
            if (neighborhood.nodes().toArray().some((ele) => ele.id() === centerId)) return 2;
            return 1;
          },
          levelWidth: () => 1,
          nodeDimensionsIncludeLabels: true,
        })
      : cy.layout({
          name: 'cose',
          animate: true,
          animationDuration: COSE_ANIMATION_DURATION,
          nodeRepulsion: () => COSE_NODE_REPULSION,
          idealEdgeLength: () => COSE_IDEAL_EDGE_LENGTH,
          gravity: COSE_GRAVITY,
          nodeDimensionsIncludeLabels: true,
          fit: true,
          padding: FIT_PADDING,
        });

    layout.on('layoutstop', () => {
      const currentCy = cyRef.current;
      if (!currentCy) return;
      const centerNode = currentCy.$('node.center');
      if (centerNode.length > 0) {
        const neighborhood = centerNode.closedNeighborhood();
        currentCy.fit(neighborhood, FIT_PADDING * 1.5);
        if (currentCy.zoom() < FOCUS_MIN_ZOOM) {
          currentCy.zoom(FOCUS_MIN_ZOOM);
          currentCy.center(centerNode);
        }
      } else {
        currentCy.fit(undefined, FIT_PADDING);
      }
      applyGraphSelection(currentCy, selectedNodeId ?? null);
    });
    layout.run();
  }, [centerId, centerNodeType, selectedNodeId]);

  useEffect(() => {
    const containerElement = containerRef.current;
    if (!containerElement) return;
    const container = containerElement;

    function tryInitialize(): void {
      const rect = container.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0 || cyRef.current) return;

      const cy = cytoscape({
        container,
        elements: [],
        style,
        layout: { name: 'preset' },
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: false,
        minZoom: 0.3,
        maxZoom: 3,
      });

      cy.on('tap', 'node', (evt) => {
        const node = evt.target;
        const d = node.data();
        const originalNode = nodeMap.get(d.id);
        onNodeSelectRef.current?.(originalNode ?? { id: d.id, name: d.fullLabel ?? d.label, type: d.type });
      });

      cy.on('tap', (evt) => {
        if (evt.target === cy) {
          onNodeSelectRef.current?.(null);
        }
      });

      cy.on('mouseover', 'edge', (evt) => {
        evt.target.style('text-opacity', 1);
        evt.target.style('line-opacity', EDGE_ACTIVE_OPACITY);
      });
      cy.on('mouseout', 'edge', (evt) => {
        const selected = cy.$('node:selected');
        if (selected.length > 0) {
          const neighborhood = selected.connectedEdges();
          if (neighborhood.contains(evt.target)) return;
        }
        evt.target.style('text-opacity', 0);
        evt.target.style('line-opacity', EDGE_OPACITY);
      });

      cyRef.current = cy;
    }

    tryInitialize();
    resizeObserverRef.current?.disconnect();
    resizeObserverRef.current = new ResizeObserver(() => {
      if (!cyRef.current) {
        tryInitialize();
      } else {
        cyRef.current.resize();
      }
    });
    resizeObserverRef.current.observe(container);

    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
      cyRef.current?.destroy();
      cyRef.current = null;
    };
  }, [nodeMap, style]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;

    const existingPositions = new Map<string, { x: number; y: number }>();
    cy.nodes().forEach((node) => {
      const position = node.position();
      existingPositions.set(node.id(), { x: position.x, y: position.y });
    });

    cy.elements().remove();
    cy.add(buildElements(existingPositions));

    const centerChanged = prevCenterIdRef.current !== (centerId ?? null);
    prevCenterIdRef.current = centerId ?? null;
    runLayout(cy, centerChanged || existingPositions.size === 0);
  }, [buildElements, centerId, runLayout]);

  useEffect(() => {
    const cy = cyRef.current;
    if (!cy) return;
    applyGraphSelection(cy, selectedNodeId ?? null);
  }, [selectedNodeId]);

  const resetView = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    clearGraphSelection(cy);
    cy.fit(undefined, FIT_PADDING);
  }, []);

  return { containerRef, resetView };
}
