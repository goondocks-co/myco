import { useEffect, useRef, useCallback } from 'react';
import cytoscape, { type Core, type ElementDefinition, type NodeSingular } from 'cytoscape';

/* ---------- Constants ---------- */

/** Node color by entity type — sage for concept, ochre for component, terracotta for bug, gray for tool/file. */
const NODE_COLORS: Record<string, string> = {
  concept: '#abcfb8',
  component: '#edbf7f',
  bug: '#ffb4a1',
  tool: '#8b928c',
  file: '#8b928c',
  other: '#6e7370',
};
const DEFAULT_NODE_COLOR = '#6e7370';

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

/** Fit padding (px) used by resetView. */
const FIT_PADDING = 50;

/** Label truncation length for long node names. */
const NODE_LABEL_MAX_LENGTH = 20;

/* ---------- Types ---------- */

export interface GraphNode {
  id: string;
  name: string;
  type: string;
  depth?: number;
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
}

/* ---------- Helpers ---------- */

/** Compute node size based on its degree (connection count). */
function nodeSizeFromDegree(degree: number): number {
  const t = Math.min(degree / NODE_SIZE_DEGREE_CAP, 1);
  return NODE_SIZE_MIN + t * (NODE_SIZE_MAX - NODE_SIZE_MIN);
}

/** Truncate label for display. */
function truncateLabel(name: string): string {
  if (name.length <= NODE_LABEL_MAX_LENGTH) return name;
  return name.slice(0, NODE_LABEL_MAX_LENGTH - 1) + '\u2026';
}

/** Get node color for a given type. */
function nodeColor(type: string): string {
  return NODE_COLORS[type?.toLowerCase()] ?? DEFAULT_NODE_COLOR;
}

/* ---------- Hook ---------- */

export function useGraphCanvas({ nodes, edges, onNodeSelect }: UseGraphCanvasOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    /* Build a degree map for sizing */
    const degreeMap = new Map<string, number>();
    for (const n of nodes) {
      degreeMap.set(n.id, 0);
    }
    for (const e of edges) {
      degreeMap.set(e.source_id, (degreeMap.get(e.source_id) ?? 0) + 1);
      degreeMap.set(e.target_id, (degreeMap.get(e.target_id) ?? 0) + 1);
    }

    const elements: ElementDefinition[] = [
      ...nodes.map((n) => ({
        data: {
          id: n.id,
          label: truncateLabel(n.name),
          fullLabel: n.name,
          type: n.type,
          degree: degreeMap.get(n.id) ?? 0,
          nodeSize: nodeSizeFromDegree(degreeMap.get(n.id) ?? 0),
        },
      })),
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

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        /* ---- Nodes ---- */
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': (ele: NodeSingular) => nodeColor(ele.data('type')),
            'background-opacity': 0.9,
            color: '#e5e2e1',
            'font-size': NODE_LABEL_FONT_SIZE,
            'font-family': 'Inter, system-ui, sans-serif',
            'text-valign': 'bottom',
            'text-margin-y': NODE_LABEL_MARGIN_Y,
            'text-outline-color': '#111111',
            'text-outline-width': 2,
            'text-outline-opacity': 0.8,
            width: 'data(nodeSize)',
            height: 'data(nodeSize)',
            'border-width': 0,
            'border-color': '#abcfb8',
            'border-opacity': 0,
            'overlay-opacity': 0,
          },
        },
        /* ---- Node hover ---- */
        {
          selector: 'node:active',
          style: {
            'overlay-opacity': 0.08,
            'overlay-color': '#abcfb8',
          },
        },
        /* ---- Selected node — glowing border ring ---- */
        {
          selector: 'node:selected',
          style: {
            'border-width': SELECTED_BORDER_WIDTH,
            'border-color': (ele: NodeSingular) => nodeColor(ele.data('type')),
            'border-opacity': SELECTED_BORDER_OPACITY,
            'background-opacity': 1,
          },
        },
        /* ---- Edges — organic bezier curves ---- */
        {
          selector: 'edge',
          style: {
            width: EDGE_WIDTH,
            'line-color': '#8b928c',
            'line-opacity': EDGE_OPACITY,
            'curve-style': 'unbundled-bezier',
            'control-point-distances': [40],
            'control-point-weights': [0.5],
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#8b928c',
            'arrow-scale': ARROW_SCALE,
            label: 'data(label)',
            'font-size': EDGE_LABEL_FONT_SIZE,
            'font-family': 'Inter, system-ui, sans-serif',
            color: '#8b928c',
            'text-opacity': 0,
            'text-rotation': 'autorotate',
            'text-margin-y': -8,
            'text-outline-color': '#111111',
            'text-outline-width': 2,
            'text-outline-opacity': 0.7,
          },
        },
        /* ---- Hovered edges show labels ---- */
        {
          selector: 'edge:active',
          style: {
            'text-opacity': 1,
            'line-opacity': EDGE_ACTIVE_OPACITY,
          },
        },
        /* ---- Fade unconnected nodes when one is selected ---- */
        {
          selector: 'node.faded',
          style: {
            opacity: 0.3,
          },
        },
        {
          selector: 'edge.faded',
          style: {
            opacity: 0.1,
          },
        },
      ],
      layout: {
        name: 'cose',
        animate: true,
        animationDuration: COSE_ANIMATION_DURATION,
        nodeRepulsion: () => COSE_NODE_REPULSION,
        idealEdgeLength: () => COSE_IDEAL_EDGE_LENGTH,
        gravity: COSE_GRAVITY,
        nodeDimensionsIncludeLabels: true,
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
      minZoom: 0.3,
      maxZoom: 3,
    });

    /* Node click — select and highlight neighborhood */
    cy.on('tap', 'node', (evt) => {
      const node = evt.target;
      const d = node.data();

      /* Clear previous fading */
      cy.elements().removeClass('faded');

      /* Fade everything that is not in the neighborhood */
      const neighborhood = node.closedNeighborhood();
      cy.elements().not(neighborhood).addClass('faded');

      /* Brighten connected edges */
      node.connectedEdges().style({
        'line-opacity': EDGE_ACTIVE_OPACITY,
        'text-opacity': 0.9,
        width: 2,
      });

      onNodeSelect?.({ id: d.id, name: d.fullLabel ?? d.label, type: d.type });
    });

    /* Background click — clear selection and fading */
    cy.on('tap', (evt) => {
      if (evt.target === cy) {
        cy.elements().removeClass('faded');
        /* Reset edge styles */
        cy.edges().style({
          'line-opacity': EDGE_OPACITY,
          'text-opacity': 0,
          width: EDGE_WIDTH,
        });
        onNodeSelect?.(null);
      }
    });

    /* Edge hover — show label */
    cy.on('mouseover', 'edge', (evt) => {
      evt.target.style('text-opacity', 1);
      evt.target.style('line-opacity', EDGE_ACTIVE_OPACITY);
    });
    cy.on('mouseout', 'edge', (evt) => {
      /* Only reset if not connected to selected node */
      const selected = cy.$('node:selected');
      if (selected.length > 0) {
        const neighborhood = selected.connectedEdges();
        if (neighborhood.contains(evt.target)) return;
      }
      evt.target.style('text-opacity', 0);
      evt.target.style('line-opacity', EDGE_OPACITY);
    });

    cyRef.current = cy;
    return () => {
      cy.destroy();
      cyRef.current = null;
    };
  }, [nodes, edges, onNodeSelect]);

  const resetView = useCallback(() => {
    const cy = cyRef.current;
    if (!cy) return;
    cy.elements().removeClass('faded');
    cy.edges().style({
      'line-opacity': EDGE_OPACITY,
      'text-opacity': 0,
      width: EDGE_WIDTH,
    });
    cy.fit(undefined, FIT_PADDING);
  }, []);

  return { containerRef, resetView };
}
