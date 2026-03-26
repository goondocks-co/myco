import { useGraphCanvas, type GraphNode, type GraphEdge } from '../../hooks/use-graph-canvas';
import { Button } from '../ui/button';

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
      <div ref={containerRef} className="absolute inset-0 rounded-md bg-surface-container-lowest" />
      <div className="absolute top-3 right-3 z-10">
        <Button variant="secondary" size="sm" onClick={resetView}>Reset View</Button>
      </div>
      {nodes.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center">
          <p className="font-sans text-sm text-on-surface-variant">No entities to display</p>
        </div>
      )}
    </div>
  );
}
