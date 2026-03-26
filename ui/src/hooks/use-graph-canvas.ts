import { useEffect, useRef, useCallback } from 'react';
import cytoscape, { type Core, type ElementDefinition } from 'cytoscape';

/* ---------- Constants ---------- */

const NODE_COLORS: Record<string, string> = {
  concept: '#abcfb8',
  component: '#edbf7f',
  bug: '#ffb4a1',
  tool: '#8b928c',
  file: '#8b928c',
};
const DEFAULT_NODE_COLOR = '#8b928c';

/** Node size in the graph layout (px). */
const NODE_SIZE = 24;

/** Font size for node labels (px). */
const NODE_LABEL_FONT_SIZE = 10;

/** Vertical margin between node and label (px). */
const NODE_LABEL_MARGIN_Y = 6;

/** Edge width (px). */
const EDGE_WIDTH = 1;

/** Edge line opacity. */
const EDGE_OPACITY = 0.3;

/** Arrow scale for directed edges. */
const ARROW_SCALE = 0.6;

/** Selected node border width (px). */
const SELECTED_BORDER_WIDTH = 2;

/** COSE layout: node repulsion force. */
const COSE_NODE_REPULSION = 8000;

/** COSE layout: ideal edge length (px). */
const COSE_IDEAL_EDGE_LENGTH = 100;

/** COSE layout: gravity pull toward center. */
const COSE_GRAVITY = 0.25;

/** COSE layout: animation duration (ms). */
const COSE_ANIMATION_DURATION = 500;

/** Fit padding (px) used by resetView. */
const FIT_PADDING = 50;

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

/* ---------- Hook ---------- */

export function useGraphCanvas({ nodes, edges, onNodeSelect }: UseGraphCanvasOptions) {
  const containerRef = useRef<HTMLDivElement>(null);
  const cyRef = useRef<Core | null>(null);

  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    const elements: ElementDefinition[] = [
      ...nodes.map((n) => ({
        data: { id: n.id, label: n.name, type: n.type },
      })),
      ...edges.map((e, i) => ({
        data: { id: `edge-${i}`, source: e.source_id, target: e.target_id, label: e.label ?? '' },
      })),
    ];

    const cy = cytoscape({
      container: containerRef.current,
      elements,
      style: [
        {
          selector: 'node',
          style: {
            label: 'data(label)',
            'background-color': (ele) => NODE_COLORS[ele.data('type')?.toLowerCase()] ?? DEFAULT_NODE_COLOR,
            color: '#e5e2e1',
            'font-size': NODE_LABEL_FONT_SIZE,
            'font-family': 'Inter, system-ui, sans-serif',
            'text-valign': 'bottom',
            'text-margin-y': NODE_LABEL_MARGIN_Y,
            width: NODE_SIZE,
            height: NODE_SIZE,
          },
        },
        {
          selector: 'edge',
          style: {
            width: EDGE_WIDTH,
            'line-color': '#8b928c',
            'line-opacity': EDGE_OPACITY,
            'curve-style': 'bezier',
            'target-arrow-shape': 'triangle',
            'target-arrow-color': '#8b928c',
            'arrow-scale': ARROW_SCALE,
          },
        },
        {
          selector: 'node:selected',
          style: {
            'border-width': SELECTED_BORDER_WIDTH,
            'border-color': '#abcfb8',
            'background-color': '#abcfb8',
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
      },
      userZoomingEnabled: true,
      userPanningEnabled: true,
      boxSelectionEnabled: false,
    });

    cy.on('tap', 'node', (evt) => {
      const d = evt.target.data();
      onNodeSelect?.({ id: d.id, name: d.label, type: d.type });
    });

    cy.on('tap', (evt) => {
      if (evt.target === cy) onNodeSelect?.(null);
    });

    cyRef.current = cy;
    return () => { cy.destroy(); cyRef.current = null; };
  }, [nodes, edges, onNodeSelect]);

  const resetView = useCallback(() => { cyRef.current?.fit(undefined, FIT_PADDING); }, []);

  return { containerRef, resetView };
}
