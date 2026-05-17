import { Terminal } from 'lucide-react';
import { Surface } from '../ui/surface';
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
    <div className="flex justify-between gap-2">
      <dt className="text-on-surface-variant">{k}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}

export function DaemonStatusCard({ uptimeSeconds, port, version }: Props) {
  return (
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-secondary">
        <Terminal className="h-3.5 w-3.5" />
        <span>Daemon</span>
      </div>
      <div className="text-lg font-medium text-on-surface">{formatUptime(uptimeSeconds)}</div>
      <dl className="space-y-1 text-xs">
        <Row k="Port"><code className="font-mono">:{port}</code></Row>
        <Row k="Version"><code className="font-mono">{version}</code></Row>
        <Row k="Status"><Badge variant="default">running</Badge></Row>
      </dl>
    </Surface>
  );
}
