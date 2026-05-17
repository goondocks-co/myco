import { Trees } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
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
      <Surface level="low" className="rounded-lg p-5">
        <SectionHeader>Other Groves</SectionHeader>
        <p className="mt-2 text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    );
  }

  if (others.length === 0) {
    return (
      <Surface level="low" className="rounded-lg p-5">
        <SectionHeader>Other Groves</SectionHeader>
        <p className="mt-2 text-sm text-on-surface-variant">
          You only have one Grove. Create another with <code className="font-mono">myco grove create</code>.
        </p>
      </Surface>
    );
  }

  return (
    <Surface level="low" className="space-y-3 rounded-lg p-5">
      <SectionHeader>Other Groves</SectionHeader>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {others.map((g) => (
          <Link
            key={g.slug}
            to={`/g/${g.slug}`}
            className="block rounded-md border border-outline-variant/10 p-3 transition-colors hover:bg-surface-container"
          >
            <div className="flex items-center gap-2">
              <Trees className="h-3.5 w-3.5 text-on-surface-variant" />
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
    </Surface>
  );
}
