import { Cpu, ArrowRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
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
    <Panel
      tone="sage"
      eyebrow={<IconEyebrow Icon={Cpu} tone="sage">Grove</IconEyebrow>}
      title="Vault"
      actions={
        <Link
          to={`/g/${groveSlug}/operations`}
          className="inline-flex items-center gap-1 text-xs font-sans text-on-surface-variant hover:text-on-surface"
        >
          Operations <ArrowRight className="h-3 w-3" />
        </Link>
      }
    >
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
    </Panel>
  );
}
