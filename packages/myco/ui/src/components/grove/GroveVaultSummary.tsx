import { Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { Eyebrow } from '../ui/eyebrow';
import { MetricCard } from '../ui/metric-card';
import { useEmbeddingDetails } from '../../hooks/use-embedding-details';
import { useDatabaseDetails } from '../../hooks/use-database-details';
import { formatBytes } from '../../lib/format';

interface Props {
  groveSlug: string;
}

export function GroveVaultSummary({ groveSlug }: Props) {
  const { data: emb } = useEmbeddingDetails('grove');
  const { data: db } = useDatabaseDetails();

  const totalPending = emb ? Object.values(emb.pending).reduce((a, b) => a + b, 0) : 0;

  return (
    <Surface level="low" accent="sage" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-sage" />
          <div className="space-y-0.5">
            <Eyebrow tone="sage">Grove</Eyebrow>
            <h3 className="myco-display-sm text-on-surface m-0">Vault</h3>
          </div>
        </div>
        <Link
          to={`/g/${groveSlug}/operations`}
          className="text-xs text-sage hover:text-sage/80"
        >
          Manage in Operations →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Vectors" value={emb ? String(emb.total) : '—'} tone="sage" mono />
        <MetricCard
          label="Pending"
          value={String(totalPending)}
          tone={totalPending > 0 ? 'ochre' : 'default'}
          mono
        />
        <MetricCard
          label="DB size"
          value={db ? formatBytes(db.file.size_bytes) : '—'}
          tone="sage"
          mono
        />
        <MetricCard
          label="Fragmentation"
          value={db ? `${db.file.fragmentation_pct.toFixed(1)}%` : '—'}
          tone={db && db.file.fragmentation_pct > 25 ? 'ochre' : 'default'}
          mono
        />
      </div>
    </Surface>
  );
}
