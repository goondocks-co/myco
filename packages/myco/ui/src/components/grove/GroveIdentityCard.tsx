import { Trees } from 'lucide-react';
import { Panel } from '../ui/panel';

interface Props {
  name: string;
  slug: string;
  projectCount: number;
  machineId: string;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-on-surface-variant">{k}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}

export function GroveIdentityCard({ name, slug, projectCount, machineId }: Props) {
  return (
    <Panel
      tone="sage"
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <Trees className="h-3 w-3" />
          Grove
        </span>
      }
      title={name}
    >
      <dl className="flex flex-col gap-1">
        <Row k="Slug"><code className="font-mono">{slug}</code></Row>
        <Row k="Projects"><span>{projectCount}</span></Row>
        <Row k="Machine"><code className="font-mono">{machineId}</code></Row>
      </dl>
    </Panel>
  );
}
