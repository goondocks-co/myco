import { Trees } from 'lucide-react';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { DefRow } from '../ui/def-row';

interface Props {
  name: string;
  slug: string;
  projectCount: number;
  machineId: string;
}

export function GroveIdentityCard({ name, slug, projectCount, machineId }: Props) {
  return (
    <Panel
      tone="sage"
      eyebrow={<IconEyebrow Icon={Trees} tone="sage">Grove</IconEyebrow>}
      title={name}
    >
      <dl className="flex flex-col gap-1">
        <DefRow term="Slug"><code className="font-mono">{slug}</code></DefRow>
        <DefRow term="Projects"><span>{projectCount}</span></DefRow>
        <DefRow term="Machine"><code className="font-mono">{machineId}</code></DefRow>
      </dl>
    </Panel>
  );
}
