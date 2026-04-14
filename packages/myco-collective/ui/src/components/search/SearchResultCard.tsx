import { FileJson, FolderTree, Sparkles } from 'lucide-react';
import { Badge } from '../ui/badge';
import { cn } from '../../lib/cn';
import type { NormalizedSearchResult } from './model';

function iconForType(typeLabel: string) {
  if (typeLabel.toLowerCase().includes('spore')) return Sparkles;
  if (typeLabel.toLowerCase().includes('plan')) return FolderTree;
  return FileJson;
}

interface SearchResultCardProps {
  result: NormalizedSearchResult;
  selected: boolean;
  onSelect: () => void;
}

export function SearchResultCard({ result, selected, onSelect }: SearchResultCardProps) {
  const Icon = iconForType(result.typeLabel);

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'w-full border-b border-[var(--ghost-border)] px-4 py-3 text-left transition-all last:border-b-0',
        selected
          ? 'bg-surface-container text-on-surface shadow-[inset_2px_0_0_var(--primary)]'
          : 'bg-transparent hover:bg-surface-container/60',
      )}
    >
      <div className="flex items-start gap-3">
        <div className="mt-0.5 text-primary">
          <Icon className="h-3.5 w-3.5" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <div className="min-w-0 flex-1 font-sans text-sm font-medium text-on-surface">{result.title}</div>
            <Badge variant={selected ? 'accent' : 'outline'}>{result.scoreLabel}</Badge>
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant="subtle">{result.projectName}</Badge>
            <Badge variant="outline">{result.typeLabel}</Badge>
          </div>
          {result.preview && (
            <p className="mt-2 text-sm leading-6 text-on-surface-variant">
              {result.preview}
            </p>
          )}
        </div>
      </div>
    </button>
  );
}
