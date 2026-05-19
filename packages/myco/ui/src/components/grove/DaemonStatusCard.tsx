import { Terminal } from 'lucide-react';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { DefRow } from '../ui/def-row';
import { Badge } from '../ui/badge';
import { formatUptime } from '../ui/daemon-status-pill';

interface Props {
  uptimeSeconds: number;
  port: number;
  version: string;
}

export function DaemonStatusCard({ uptimeSeconds, port, version }: Props) {
  return (
    <Panel
      tone="sage"
      eyebrow={<IconEyebrow Icon={Terminal} tone="sage">Daemon</IconEyebrow>}
      title={formatUptime(uptimeSeconds)}
    >
      <dl className="flex flex-col gap-1">
        <DefRow term="Port"><code className="font-mono">:{port}</code></DefRow>
        <DefRow term="Version"><code className="font-mono">{version}</code></DefRow>
        <DefRow term="Status"><Badge variant="default">running</Badge></DefRow>
      </dl>
    </Panel>
  );
}
