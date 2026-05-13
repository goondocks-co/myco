import { GitCompare, X } from 'lucide-react';
import { Button } from './button';
import { cn } from '../../lib/cn';

export interface CompareBarProps {
  selectedCount: number;
  onClear: () => void;
  onCompare: () => void;
  /** Defaults to 2. Primary action is disabled when count < this. */
  minSelected?: number;
  /** Defaults to "Compare". */
  primaryLabel?: string;
  /** Defaults to "run". Used to render "Compare 1 run". */
  nounSingular?: string;
  /** Defaults to "runs". Used to render "Compare 3 runs". */
  nounPlural?: string;
  className?: string;
}

export function CompareBar({
  selectedCount,
  onClear,
  onCompare,
  minSelected = 2,
  primaryLabel = 'Compare',
  nounSingular = 'run',
  nounPlural = 'runs',
  className,
}: CompareBarProps) {
  if (selectedCount === 0) return null;
  const noun = selectedCount === 1 ? nounSingular : nounPlural;
  return (
    <div
      role="region"
      aria-label="Selection actions"
      className={cn(
        'fixed bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 rounded-full bg-surface-container-high px-4 py-2 shadow-lg border border-outline-variant/30',
        className,
      )}
    >
      <span className="font-sans text-sm text-on-surface">
        {selectedCount} selected
      </span>
      <Button
        size="sm"
        variant="default"
        className="gap-2"
        disabled={selectedCount < minSelected}
        onClick={onCompare}
      >
        <GitCompare className="h-3.5 w-3.5" />
        {primaryLabel} {selectedCount} {noun}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        className="gap-2 text-on-surface-variant"
        onClick={onClear}
      >
        <X className="h-3.5 w-3.5" />
        Clear selection
      </Button>
    </div>
  );
}
