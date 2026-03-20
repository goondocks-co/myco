import type { StatsResponse } from '../../hooks/use-daemon';
import { totalSpores } from '../../lib/vault';

/* ---------- Constants ---------- */

const HUB_X = 250;
const HUB_Y = 200;
const HUB_RADIUS = 40;
const ORBIT_RADIUS = 140;
const NODE_RADIUS = 30;
const HALO_RADIUS = 38;
const NODE_COUNT = 5;
const PULSE_DURATION = '3s';
const DETAIL_MAX_CHARS = 16;

/** Starting angle offset so the first node sits at top-center */
const ANGLE_OFFSET = -Math.PI / 2;

const COLOR_ACTIVE = 'hsl(142, 71%, 45%)';
const COLOR_IDLE = 'hsl(142, 71%, 45%)';
const COLOR_COOLING = 'hsl(38, 92%, 50%)';
const COLOR_DORMANT = 'hsl(215, 10%, 40%)';
const COLOR_OFF = 'hsl(215, 10%, 25%)';

const CONNECTION_OPACITY_DEFAULT = 0.3;
const CONNECTION_OPACITY_ACTIVE = 0.6;

const FONT_FAMILY = 'var(--font-ui, monospace)';

/* ---------- Types ---------- */

type NodeStatus = 'active' | 'idle' | 'cooling' | 'dormant' | 'off';

interface TopologyNode {
  id: string;
  label: string;
  detail: string;
  status: NodeStatus;
}

/* ---------- Helpers ---------- */

function statusColor(status: NodeStatus): string {
  switch (status) {
    case 'active':
      return COLOR_ACTIVE;
    case 'idle':
      return COLOR_IDLE;
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

function nodePosition(index: number): { x: number; y: number } {
  const angle = ANGLE_OFFSET + (2 * Math.PI * index) / NODE_COUNT;
  return {
    x: HUB_X + ORBIT_RADIUS * Math.cos(angle),
    y: HUB_Y + ORBIT_RADIUS * Math.sin(angle),
  };
}

function formatModel(info: { provider: string; model: string } | null): string {
  if (!info) return 'none';
  return info.model;
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
  const processorModel = formatModel(stats.intelligence.processor);
  const embeddingModel = formatModel(stats.intelligence.embedding);

  const digestEnabled = stats.digest?.enabled ?? false;
  const digestState = stats.digest?.metabolism_state ?? null;

  return [
    {
      id: 'processor',
      label: 'Processor',
      detail: processorModel,
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
      label: 'Embedding',
      detail: `${embeddingModel} (${stats.index.vector_count})`,
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
}

/* ---------- Sub-components ---------- */

function Connection({ index, status }: { index: number; status: NodeStatus }) {
  const { x, y } = nodePosition(index);
  const active = isPulsing(status);
  const color = statusColor(status);

  return (
    <line
      x1={HUB_X}
      y1={HUB_Y}
      x2={x}
      y2={y}
      stroke={color}
      strokeWidth={1.5}
      strokeDasharray={status === 'off' ? '4 4' : undefined}
      opacity={active ? CONNECTION_OPACITY_ACTIVE : CONNECTION_OPACITY_DEFAULT}
    >
      {active && (
        <animate
          attributeName="opacity"
          values={`${CONNECTION_OPACITY_DEFAULT};${CONNECTION_OPACITY_ACTIVE};${CONNECTION_OPACITY_DEFAULT}`}
          dur={PULSE_DURATION}
          repeatCount="indefinite"
        />
      )}
    </line>
  );
}

function TopologyNodeSvg({ node, index }: { node: TopologyNode; index: number }) {
  const { x, y } = nodePosition(index);
  const color = statusColor(node.status);
  const pulses = isPulsing(node.status);

  return (
    <g>
      <title>{`${node.label}: ${node.detail}`}</title>

      {/* Halo (pulsing glow for active nodes) */}
      {pulses && (
        <circle cx={x} cy={y} r={HALO_RADIUS} fill={color} opacity={0}>
          <animate
            attributeName="opacity"
            values="0;0.15;0"
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values={`${HALO_RADIUS};${HALO_RADIUS + 8};${HALO_RADIUS}`}
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Node circle */}
      <circle
        cx={x}
        cy={y}
        r={NODE_RADIUS}
        fill={color}
        fillOpacity={0.12}
        stroke={color}
        strokeWidth={1.5}
        strokeOpacity={node.status === 'off' ? 0.3 : 0.7}
      />

      {/* Label */}
      <text
        x={x}
        y={y - 6}
        textAnchor="middle"
        fill="currentColor"
        fontSize={10}
        fontFamily={FONT_FAMILY}
        fontWeight={600}
        opacity={0.9}
      >
        {node.label}
      </text>

      {/* Detail */}
      <text
        x={x}
        y={y + 8}
        textAnchor="middle"
        fill="currentColor"
        fontSize={8}
        fontFamily={FONT_FAMILY}
        opacity={0.5}
      >
        {node.detail.length > DETAIL_MAX_CHARS ? node.detail.slice(0, DETAIL_MAX_CHARS - 1) + '\u2026' : node.detail}
      </text>
    </g>
  );
}

/* ---------- Main component ---------- */

export function MycoTopology({ stats }: { stats: StatsResponse }) {
  const nodes = buildNodes(stats);
  const hubHealthy = true; // daemon is reachable if we have stats
  const hubColor = hubHealthy ? COLOR_ACTIVE : COLOR_OFF;
  const hasActiveSessions = stats.daemon.active_sessions.length > 0;

  return (
    <svg
      viewBox="0 0 500 400"
      width="100%"
      className="max-h-[400px]"
      role="img"
      aria-label="Myco system topology"
    >
      {/* Connections from hub to nodes */}
      {nodes.map((node, i) => (
        <Connection key={node.id} index={i} status={node.status} />
      ))}

      {/* Hub halo */}
      {hasActiveSessions && (
        <circle cx={HUB_X} cy={HUB_Y} r={HUB_RADIUS + 6} fill={hubColor} opacity={0}>
          <animate
            attributeName="opacity"
            values="0;0.12;0"
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
          <animate
            attributeName="r"
            values={`${HUB_RADIUS + 6};${HUB_RADIUS + 14};${HUB_RADIUS + 6}`}
            dur={PULSE_DURATION}
            repeatCount="indefinite"
          />
        </circle>
      )}

      {/* Hub circle */}
      <circle
        cx={HUB_X}
        cy={HUB_Y}
        r={HUB_RADIUS}
        fill={hubColor}
        fillOpacity={0.15}
        stroke={hubColor}
        strokeWidth={2}
        strokeOpacity={0.8}
      />

      {/* Hub label */}
      <text
        x={HUB_X}
        y={HUB_Y - 4}
        textAnchor="middle"
        fill="currentColor"
        fontSize={14}
        fontFamily={FONT_FAMILY}
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
        fontSize={9}
        fontFamily={FONT_FAMILY}
        opacity={0.45}
      >
        v{stats.daemon.version}
      </text>

      <title>Myco Daemon — v{stats.daemon.version}</title>

      {/* Orbit nodes */}
      {nodes.map((node, i) => (
        <TopologyNodeSvg key={node.id} node={node} index={i} />
      ))}
    </svg>
  );
}
