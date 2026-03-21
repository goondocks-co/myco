import type { StatsResponse } from '../../hooks/use-daemon';
import { totalSpores } from '../../lib/vault';

/* ---------- Constants ---------- */

const SVG_WIDTH = 500;
const SVG_HEIGHT = 400;
const HUB_X = 240;
const HUB_Y = 195;
const HUB_RADIUS = 44;
const HUB_HALO_INNER = 50;
const HUB_HALO_OUTER = 62;
const PULSE_DURATION = '3s';
const SPORE_DRIFT_DURATION = '4s';
const DETAIL_MAX_CHARS = 12;
const LABEL_FONT_SIZE = 9;
const DETAIL_FONT_SIZE = 7;
const HUB_LABEL_FONT_SIZE = 14;
const HUB_DETAIL_FONT_SIZE = 9;
const SPORE_RADIUS = 1.8;
const SPORE_COUNT_PER_ACTIVE_PATH = 2;

const SVG_TEXT_STYLE = 'svg text { font-family: var(--font-ui, ui-monospace, monospace); }';
const CONNECTION_OPACITY_DEFAULT = 0.25;
const CONNECTION_OPACITY_ACTIVE = 0.55;

/* Node-specific colors (emerald/fungal palette) */
const NODE_COLORS: Record<string, string> = {
  daemon: 'hsl(142, 71%, 45%)',
  processor: 'hsl(160, 60%, 40%)',
  digest: 'hsl(142, 50%, 55%)',
  consolidation: 'hsl(165, 55%, 48%)',
  embedding: 'hsl(175, 50%, 40%)',
  vault: 'hsl(130, 45%, 35%)',
  sessions: 'hsl(155, 60%, 50%)',
};

const COLOR_COOLING = 'hsl(38, 92%, 50%)';
const COLOR_DORMANT = 'hsl(215, 10%, 40%)';
const COLOR_OFF = 'hsl(215, 10%, 25%)';

/* Organic node positions — asymmetric, like a mycelium mat */
const NODE_POSITIONS: Record<string, { x: number; y: number; radius: number }> = {
  processor: { x: 100, y: 80, radius: 38 },
  digest: { x: 400, y: 110, radius: 36 },
  consolidation: { x: 480, y: 195, radius: 24 },
  embedding: { x: 75, y: 310, radius: 38 },
  vault: { x: 415, y: 290, radius: 38 },
  sessions: { x: 250, y: 360, radius: 36 },
};

/* ---------- Types ---------- */

type NodeStatus = 'active' | 'idle' | 'cooling' | 'dormant' | 'off';

interface TopologyNode {
  id: string;
  label: string;
  detail: string;
  status: NodeStatus;
}

/* ---------- Helpers ---------- */

function statusColor(nodeId: string, status: NodeStatus): string {
  switch (status) {
    case 'active':
    case 'idle':
      return NODE_COLORS[nodeId] ?? NODE_COLORS.daemon;
    case 'cooling':
      return COLOR_COOLING;
    case 'dormant':
      return COLOR_DORMANT;
    case 'off':
      return COLOR_OFF;
  }
}

function isPulsing(status: NodeStatus): boolean {
  return status === 'active';
}

function metabolismToStatus(state: string | null, enabled: boolean): NodeStatus {
  if (!enabled) return 'off';
  if (!state) return 'dormant';
  switch (state) {
    case 'active':
      return 'active';
    case 'cooling':
      return 'cooling';
    case 'dormant':
      return 'dormant';
    default:
      return 'idle';
  }
}

function buildNodes(stats: StatsResponse): TopologyNode[] {
  const hasActiveSessions = stats.daemon.active_sessions.length > 0;

  const digestEnabled = stats.digest?.enabled ?? false;
  const digestState = stats.digest?.metabolism_state ?? null;
  const consolidationEnabled = stats.digest?.consolidation_enabled ?? false;

  const sporeTotal = totalSpores(stats.vault.spore_counts);

  const nodes: TopologyNode[] = [
    {
      id: 'processor',
      label: 'Spores',
      detail: `${sporeTotal} total`,
      status: hasActiveSessions ? 'active' : (stats.intelligence.processor ? 'idle' : 'off'),
    },
    {
      id: 'digest',
      label: 'Digest',
      detail: digestState ?? (digestEnabled ? 'ready' : 'disabled'),
      status: metabolismToStatus(digestState, digestEnabled),
    },
    {
      id: 'embedding',
      label: 'Index',
      detail: `${stats.index.fts_entries}f ${stats.index.vector_count}v`,
      status: stats.intelligence.embedding ? 'idle' : 'off',
    },
    {
      id: 'vault',
      label: 'Vault',
      detail: `${totalSpores(stats.vault.spore_counts)}s ${stats.vault.session_count}n`,
      status: 'active',
    },
    {
      id: 'sessions',
      label: 'Sessions',
      detail: `${stats.daemon.active_sessions.length} active`,
      status: hasActiveSessions ? 'active' : 'idle',
    },
  ];

  // Consolidation branches off digest — only shown when enabled
  if (consolidationEnabled) {
    const digestStatus = metabolismToStatus(digestState, digestEnabled);
    nodes.push({
      id: 'consolidation',
      label: 'Consolidate',
      detail: 'pre-pass',
      status: digestStatus === 'active' ? 'active' : (digestEnabled ? 'idle' : 'off'),
    });
  }

  return nodes;
}

/** Generate a bezier curve path between hub and a node — organic hypha shape */
function hyphaPath(nodeId: string): string {
  const pos = NODE_POSITIONS[nodeId];
  if (!pos) return '';

  const dx = pos.x - HUB_X;
  const dy = pos.y - HUB_Y;

  // Offset control points perpendicular to the line for organic curve
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len; // normal x
  const ny = dx / len; // normal y

  // Vary curvature per node for asymmetry
  const curvatures: Record<string, number> = {
    processor: 25,
    digest: -30,
    embedding: -20,
    vault: 35,
    sessions: 15,
  };
  const curve = curvatures[nodeId] ?? 20;

  // Offset start/end points to circle edges (not centers)
  const ux = dx / len; // unit vector hub→node
  const uy = dy / len;
  const startX = HUB_X + ux * HUB_RADIUS;
  const startY = HUB_Y + uy * HUB_RADIUS;
  const endX = pos.x - ux * pos.radius;
  const endY = pos.y - uy * pos.radius;

  // Control points along the edge-to-edge segment
  const edgeDx = endX - startX;
  const edgeDy = endY - startY;
  const cp1x = startX + edgeDx * 0.35 + nx * curve;
  const cp1y = startY + edgeDy * 0.35 + ny * curve;
  const cp2x = startX + edgeDx * 0.65 + nx * curve * 0.6;
  const cp2y = startY + edgeDy * 0.65 + ny * curve * 0.6;

  return `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
}

/** IDs of nodes that branch off another node instead of the hub. */
const BRANCH_PARENTS: Record<string, string> = {
  consolidation: 'digest',
};

/** Curvature magnitude (pixels) for branch hypha paths (node → child). */
const BRANCH_HYPHA_CURVE = 12;

/** Generate a bezier path from a parent node to a child node (branch hypha). */
function branchHyphaPath(childId: string): string {
  const parentId = BRANCH_PARENTS[childId];
  if (!parentId) return '';
  const parent = NODE_POSITIONS[parentId];
  const child = NODE_POSITIONS[childId];
  if (!parent || !child) return '';

  const dx = child.x - parent.x;
  const dy = child.y - parent.y;
  const len = Math.sqrt(dx * dx + dy * dy);
  const ux = dx / len;
  const uy = dy / len;

  const startX = parent.x + ux * parent.radius;
  const startY = parent.y + uy * parent.radius;
  const endX = child.x - ux * child.radius;
  const endY = child.y - uy * child.radius;

  const edgeDx = endX - startX;
  const edgeDy = endY - startY;
  const edgeLen = Math.sqrt(edgeDx * edgeDx + edgeDy * edgeDy);
  const nx = -edgeDy / edgeLen;
  const ny = edgeDx / edgeLen;

  const cp1x = startX + edgeDx * 0.4 + nx * BRANCH_HYPHA_CURVE;
  const cp1y = startY + edgeDy * 0.4 + ny * BRANCH_HYPHA_CURVE;
  const cp2x = startX + edgeDx * 0.7 + nx * BRANCH_HYPHA_CURVE * 0.5;
  const cp2y = startY + edgeDy * 0.7 + ny * BRANCH_HYPHA_CURVE * 0.5;

  return `M ${startX} ${startY} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${endX} ${endY}`;
}

/* ---------- Sub-components ---------- */

function HyphaConnection({ node }: { node: TopologyNode }) {
  const color = statusColor(node.id, node.status);
  const active = isPulsing(node.status);
  const pathId = `hypha-${node.id}`;
  const isBranch = node.id in BRANCH_PARENTS;
  const d = isBranch ? branchHyphaPath(node.id) : hyphaPath(node.id);

  return (
    <g>
      <path
        id={pathId}
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={active ? 2 : 1.5}
        strokeDasharray={node.status === 'off' ? '6 4' : undefined}
        opacity={active ? CONNECTION_OPACITY_ACTIVE : CONNECTION_OPACITY_DEFAULT}
        strokeLinecap="round"
      >
        {active && (
          <animate
            attributeName="opacity"
            values={`${CONNECTION_OPACITY_DEFAULT};${CONNECTION_OPACITY_ACTIVE};${CONNECTION_OPACITY_DEFAULT}`}
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
        )}
      </path>

      {/* Spore particles drifting along active connections */}
      {active &&
        Array.from({ length: SPORE_COUNT_PER_ACTIVE_PATH }, (_, i) => {
          const offset = i / SPORE_COUNT_PER_ACTIVE_PATH;
          return (
            <circle
              key={i}
              r={SPORE_RADIUS}
              fill={color}
              opacity={0}
            >
              <animateMotion
                dur={SPORE_DRIFT_DURATION}
                repeatCount="indefinite"
                begin={`${offset * 4}s`}
                path={d}
              />
              <animate
                attributeName="opacity"
                values="0;0.6;0.8;0.6;0"
                dur={SPORE_DRIFT_DURATION}
                repeatCount="indefinite"
                begin={`${offset * 4}s`}
              />
            </circle>
          );
        })}
    </g>
  );
}

function TopologyNodeSvg({ node }: { node: TopologyNode }) {
  const pos = NODE_POSITIONS[node.id];
  if (!pos) return null;

  const { x, y, radius } = pos;
  const color = statusColor(node.id, node.status);
  const pulses = isPulsing(node.status);
  const haloRadius = radius + 8;

  return (
    <g>
      <title>{`${node.label}: ${node.detail}`}</title>

      {/* Halo (pulsing glow for active nodes) */}
      {pulses && (
        <circle cx={x} cy={y} r={haloRadius} fill={color} opacity={0}>
          <animate
            attributeName="opacity"
            values="0;0.12;0"
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values={`${haloRadius};${haloRadius + 10};${haloRadius}`}
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Node circle — organic feel with slightly thicker stroke */}
      <circle
        cx={x}
        cy={y}
        r={radius}
        fill={color}
        fillOpacity={0.1}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={node.status === 'off' ? 0.25 : 0.65}
      />

      {/* Label */}
      <text
        x={x}
        y={y - 4}
        textAnchor="middle"
        fill="currentColor"
        fontSize={LABEL_FONT_SIZE}

        fontWeight={600}
        opacity={0.9}
      >
        {node.label}
      </text>

      {/* Detail — truncate to fit inside node circle */}
      <text
        x={x}
        y={y + 8}
        textAnchor="middle"
        fill="currentColor"
        fontSize={DETAIL_FONT_SIZE}

        opacity={0.5}
      >
        {node.detail.length > DETAIL_MAX_CHARS
          ? node.detail.slice(0, DETAIL_MAX_CHARS - 1) + '\u2026'
          : node.detail}
      </text>
    </g>
  );
}

/* ---------- Ambient spores (background particles) ---------- */

function AmbientSpores() {
  // Predefined positions so we avoid random in render
  const spores = [
    { cx: 170, cy: 140, delay: '0s' },
    { cx: 320, cy: 250, delay: '1.5s' },
    { cx: 130, cy: 200, delay: '3s' },
    { cx: 360, cy: 170, delay: '2s' },
    { cx: 200, cy: 330, delay: '0.8s' },
    { cx: 300, cy: 100, delay: '2.5s' },
  ];

  return (
    <g opacity={0.3}>
      {spores.map((s, i) => (
        <circle key={i} cx={s.cx} cy={s.cy} r={1.2} fill="hsl(142, 50%, 50%)">
          <animate
            attributeName="opacity"
            values="0;0.5;0"
            dur="5s"
            begin={s.delay}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values="1;2;1"
            dur="5s"
            begin={s.delay}
            repeatCount="indefinite"
          />
        </circle>
      ))}
    </g>
  );
}

/* ---------- Main component ---------- */

export function MycoTopology({ stats }: { stats: StatsResponse }) {
  const nodes = buildNodes(stats);
  const hubHealthy = true; // daemon is reachable if we have stats
  const hubColor = hubHealthy ? NODE_COLORS.daemon : COLOR_OFF;
  const hasActiveSessions = stats.daemon.active_sessions.length > 0;

  return (
    <svg
      viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`}
      width="100%"
      className="max-h-[400px]"
      role="img"
      aria-label="Myco system topology"
      style={{ fontSize: 'calc(1em * var(--density, 1))' }}
    >
      {/* SVG text inherits font-family from this style block, which reads the CSS variable */}
      <style>{SVG_TEXT_STYLE}</style>

      {/* Ambient spore particles */}
      <AmbientSpores />

      {/* Hyphal connections from hub to nodes */}
      {nodes.map((node) => (
        <HyphaConnection key={node.id} node={node} />
      ))}

      {/* Hub halo — the fruiting body glow */}
      {hasActiveSessions && (
        <circle cx={HUB_X} cy={HUB_Y} r={HUB_HALO_INNER} fill={hubColor} opacity={0}>
          <animate
            attributeName="opacity"
            values="0;0.1;0"
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values={`${HUB_HALO_INNER};${HUB_HALO_OUTER};${HUB_HALO_INNER}`}
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Hub circle — the fruiting body */}
      <circle
        cx={HUB_X}
        cy={HUB_Y}
        r={HUB_RADIUS}
        fill={hubColor}
        fillOpacity={0.13}
        stroke={hubColor}
        strokeWidth={2}
        strokeOpacity={0.75}
      />

      {/* Hub label */}
      <text
        x={HUB_X}
        y={HUB_Y - 4}
        textAnchor="middle"
        fill="currentColor"
        fontSize={HUB_LABEL_FONT_SIZE}

        fontWeight={700}
        opacity={0.9}
      >
        myco
      </text>
      <text
        x={HUB_X}
        y={HUB_Y + 12}
        textAnchor="middle"
        fill="currentColor"
        fontSize={HUB_DETAIL_FONT_SIZE}

        opacity={0.45}
      >
        v{stats.daemon.version}
      </text>

      <title>Myco Daemon — v{stats.daemon.version}</title>

      {/* Substrate nodes */}
      {nodes.map((node) => (
        <TopologyNodeSvg key={node.id} node={node} />
      ))}
    </svg>
  );
}
