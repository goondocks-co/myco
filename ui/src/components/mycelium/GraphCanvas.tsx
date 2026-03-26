import { useGraphCanvas, type GraphNode, type GraphEdge } from '../../hooks/use-graph-canvas';
import { Button } from '../ui/button';
import { RotateCcw } from 'lucide-react';

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  onNodeSelect?: (node: GraphNode | null) => void;
  selectedNode?: GraphNode | null;
}

export function GraphCanvas({ nodes, edges, onNodeSelect }: GraphCanvasProps) {
  const { containerRef, resetView } = useGraphCanvas({ nodes, edges, onNodeSelect });

  return (
    <div className="relative flex-1 min-h-[400px]">
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
      <div ref={containerRef} className="absolute inset-0 rounded-md" />
      {/* Controls overlay */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-2">
        <Button variant="ghost" size="sm" onClick={resetView} className="gap-1.5">
          <RotateCcw className="h-3.5 w-3.5" />
          Reset
        </Button>
      </div>
      {/* Stats overlay */}
      {nodes.length > 0 && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-3 font-mono text-[10px] text-on-surface-variant/60">
          <span>{nodes.length} nodes</span>
          <span>{edges.length} edges</span>
        </div>
      )}
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-sans text-sm text-on-surface-variant">No entities to display</p>
        </div>
      )}
    </div>
  );
}
