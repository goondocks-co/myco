import { Trees } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { Badge } from '../ui/badge';
import { useGroves } from '../../hooks/use-groves';

interface Props {
  currentGroveSlug: string;
}

export function CrossGrovePeek({ currentGroveSlug }: Props) {
  const { data, isLoading } = useGroves();
  const allGroves = data?.groves ?? [];
  const others = allGroves.filter((g) => g.slug !== currentGroveSlug);

  if (isLoading && others.length === 0) {
    return (
      <Panel tone="ochre" eyebrow="Other Groves" title="Loading…">
        <span />
      </Panel>
    );
  }

  if (others.length === 0) {
    return (
      <Panel tone="ochre" eyebrow="Other Groves" title="Just this one">
        <p className="text-sm text-on-surface-variant m-0">
          Create another with <code className="font-mono">myco grove create</code>.
        </p>
      </Panel>
    );
  }

  return (
    <Panel
      tone="ochre"
      eyebrow="Other Groves"
      title={`${others.length} ${others.length === 1 ? 'sibling Grove' : 'sibling Groves'}`}
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {others.map((g) => (
          <Link
            key={g.slug}
            to={`/g/${g.slug}`}
            className="block rounded-md border border-[var(--ghost-border)] p-3 transition-colors hover:bg-surface-container"
          >
            <div className="flex items-center gap-2">
              <Trees className="h-3.5 w-3.5 text-ochre" />
              <span className="truncate text-sm font-medium text-on-surface">{g.name}</span>
              {g.is_default && <Badge variant="outline">default</Badge>}
            </div>
            <div className="mt-1 flex gap-x-3 text-xs text-on-surface-variant">
              <span className="font-mono">{g.slug}</span>
              <span>·</span>
              <span>{g.project_count} project{g.project_count === 1 ? '' : 's'}</span>
            </div>
          </Link>
        ))}
      </div>
    </Panel>
  );
}
