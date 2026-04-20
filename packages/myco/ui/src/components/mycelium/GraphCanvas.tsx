import { useGraphCanvas, type GraphNode, type GraphEdge } from '../../hooks/use-graph-canvas';
import { Button } from '../ui/button';
import { RotateCcw } from 'lucide-react';

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeSelect?: (node: GraphNode | null) => void;
  selectedNode?: GraphNode | null;
  centerId?: string | null;
  centerNodeType?: string | null;
  isLoading?: boolean;
}

export function GraphCanvas({ nodes, edges, onNodeSelect, selectedNode, centerId, centerNodeType, isLoading }: GraphCanvasProps) {
  const { containerRef, resetView } = useGraphCanvas({
    nodes,
    edges,
    onNodeSelect,
    centerId,
    centerNodeType,
    selectedNodeId: selectedNode?.id ?? null,
  });

  return (
    <div className="absolute inset-0">
      {/* Mycelial mesh background pattern */}
      <div
        className="absolute inset-0 rounded-md bg-surface-container-lowest"
        style={{
          backgroundImage:
            'radial-gradient(circle at 2px 2px, rgba(139, 146, 140, 0.05) 1px, transparent 0)',
          backgroundSize: '40px 40px',
        }}
      />
      {/* Cytoscape container */}
      <div ref={containerRef} className="absolute inset-0 rounded-md" style={{ width: '100%', height: '100%' }} />
      {/* Controls overlay — bottom left next to stats */}
      <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3">
        {nodes.length > 0 && (
          <div className="flex items-center gap-3 font-mono text-[10px] text-on-surface-variant/60 mr-1">
            <span>{nodes.length} nodes</span>
            <span>{edges.length} edges</span>
          </div>
        )}
        <Button variant="ghost" size="sm" onClick={resetView} className="gap-1.5 h-7 text-[10px] px-2 bg-surface-container-high/40 backdrop-blur-xs">
          <RotateCcw className="h-3 w-3" />
          Reset View
        </Button>
      </div>
      {/* Empty state */}
      {!isLoading && nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-sans text-sm text-on-surface-variant">No nodes to display</p>
        </div>
      )}
    </div>
  );
}
