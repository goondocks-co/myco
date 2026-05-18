import { Terminal } from 'lucide-react';
import { Panel } from '../ui/panel';
import { Badge } from '../ui/badge';

interface Props {
  uptimeSeconds: number;
  port: number;
  version: string;
}

function formatUptime(s: number): string {
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((s % 3600) / 60);
  return `${h}h ${m}m`;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-on-surface-variant">{k}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}

export function DaemonStatusCard({ uptimeSeconds, port, version }: Props) {
  return (
    <Panel
      tone="sage"
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <Terminal className="h-3 w-3" />
          Daemon
        </span>
      }
      title={formatUptime(uptimeSeconds)}
    >
      <dl className="flex flex-col gap-1">
        <Row k="Port"><code className="font-mono">:{port}</code></Row>
        <Row k="Version"><code className="font-mono">{version}</code></Row>
        <Row k="Status"><Badge variant="default">running</Badge></Row>
      </dl>
    </Panel>
  );
}
