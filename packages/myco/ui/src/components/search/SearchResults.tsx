import { type SearchResult } from '../../hooks/use-search';
import { Badge } from '../ui/badge';
import { MessageSquare, Sparkles, ClipboardList, Activity, FileText } from 'lucide-react';

/** Maximum characters shown in a result preview line. */
const PREVIEW_MAX_CHARS = 120;

const TYPE_META: Record<string, { label: string; icon: React.ElementType }> = {
  session: { label: 'Sessions', icon: MessageSquare },
  spore: { label: 'Spores', icon: Sparkles },
  plan: { label: 'Plans', icon: ClipboardList },
  prompt_batch: { label: 'Prompt Batches', icon: Activity },
  activity: { label: 'Activities', icon: Activity },
};

function getTypeMeta(type: string) {
  return TYPE_META[type] ?? { label: type, icon: FileText };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '…';
}

function ScoreBadge({ score }: { score: number }) {
  const pct = Math.round(score * 100);
  return (
    <Badge variant="outline" className="shrink-0 text-xs tabular-nums text-on-surface-variant">
      {pct}%
    </Badge>
  );
}

interface ResultRowProps {
  result: SearchResult;
  onSelect: (result: SearchResult) => void;
  isHighlighted: boolean;
}

function ResultRow({ result, onSelect, isHighlighted }: ResultRowProps) {
  const { icon: Icon } = getTypeMeta(result.type);

  return (
    <button
      type="button"
      onClick={() => onSelect(result)}
      className={[
        'w-full flex items-start gap-3 px-3 py-2 text-left rounded-md transition-colors',
        isHighlighted
          ? 'bg-surface-container-high text-on-surface'
          : 'hover:bg-surface-container-high hover:text-on-surface',
      ].join(' ')}
    >
      <Icon className="h-4 w-4 mt-0.5 shrink-0 text-on-surface-variant" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">{result.title}</span>
        </div>
        {result.preview && (
          <p className="text-xs text-on-surface-variant mt-0.5 line-clamp-2">
            {truncate(result.preview, PREVIEW_MAX_CHARS)}
          </p>
        )}
      </div>
      <ScoreBadge score={result.score} />
    </button>
  );
}

interface SearchResultsProps {
  results: SearchResult[];
  onSelect: (result: SearchResult) => void;
  highlightedIndex: number;
}

export function SearchResults({ results, onSelect, highlightedIndex }: SearchResultsProps) {
  // Group by type
  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    const key = r.type ?? 'unknown';
    (acc[key] ??= []).push(r);
    return acc;
  }, {});

  // Track absolute index across groups for keyboard highlight
  let cursor = 0;

  return (
    <div className="py-2 space-y-1">
      {Object.entries(grouped).map(([type, items]) => {
        const { label } = getTypeMeta(type);
        const groupStart = cursor;
        cursor += items.length;

        return (
          <div key={type}>
            <div className="px-3 py-1">
              <span className="text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
                {label}
              </span>
            </div>
            {items.map((result, i) => (
              <ResultRow
                key={result.id}
                result={result}
                onSelect={onSelect}
                isHighlighted={highlightedIndex === groupStart + i}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
