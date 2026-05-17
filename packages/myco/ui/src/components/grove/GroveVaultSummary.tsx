import { Cpu } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { StatCard } from '../ui/stat-card';
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
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Cpu className="h-4 w-4 text-primary" />
          <SectionHeader>Vault</SectionHeader>
        </div>
        <Link
          to={`/g/${groveSlug}/operations`}
          className="text-xs text-primary hover:text-primary/80"
        >
          Manage in Operations →
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard label="Vectors" value={emb ? String(emb.total) : '—'} accent="sage" />
        <StatCard
          label="Pending"
          value={String(totalPending)}
          accent={totalPending > 0 ? 'ochre' : 'outline'}
        />
        <StatCard
          label="DB size"
          value={db ? formatBytes(db.file.size_bytes) : '—'}
          accent="sage"
        />
        <StatCard
          label="Fragmentation"
          value={db ? `${db.file.fragmentation_pct.toFixed(1)}%` : '—'}
          accent={db && db.file.fragmentation_pct > 25 ? 'ochre' : 'outline'}
        />
      </div>
    </Surface>
  );
}
