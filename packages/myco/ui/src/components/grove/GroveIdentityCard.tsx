import { Trees } from 'lucide-react';
import { Surface } from '../ui/surface';

interface Props {
  name: string;
  slug: string;
  projectCount: number;
  machineId: string;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <dt className="text-on-surface-variant">{k}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}

export function GroveIdentityCard({ name, slug, projectCount, machineId }: Props) {
  return (
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-primary">
        <Trees className="h-3.5 w-3.5" />
        <span>Grove</span>
      </div>
      <div className="text-lg font-medium text-on-surface">{name}</div>
      <dl className="space-y-1 text-xs">
        <Row k="Slug"><code className="font-mono">{slug}</code></Row>
        <Row k="Projects"><span>{projectCount}</span></Row>
        <Row k="Machine"><code className="font-mono">{machineId}</code></Row>
      </dl>
    </Surface>
  );
}
