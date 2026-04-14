import { ExternalLink, X } from 'lucide-react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Card } from '../ui/card';
import { SectionHeader } from '../ui/section-header';
import type { NormalizedSearchResult } from './model';

interface SearchInspectorProps {
  result: NormalizedSearchResult;
  onClose: () => void;
  mobile?: boolean;
}

export function SearchInspector({ result, onClose, mobile = false }: SearchInspectorProps) {
  const Container = mobile ? 'div' : Card;
  const containerClassName = mobile
    ? 'flex h-full flex-col bg-surface px-4 py-5'
    : 'sticky top-7 p-4';

  return (
    <Container className={containerClassName}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <SectionHeader>Result Detail</SectionHeader>
          <h3 className="mt-2 font-sans text-base font-medium text-on-surface">{result.title}</h3>
        </div>
        <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close result detail">
          <X className="h-4 w-4" />
        </Button>
      </div>

      <div className="mt-4 flex flex-wrap gap-2">
        <Badge variant="accent">{result.projectName}</Badge>
        <Badge variant="outline">{result.typeLabel}</Badge>
        <Badge variant="outline">{result.scoreLabel}</Badge>
      </div>

      {result.preview && (
        <p className="mt-4 text-sm leading-6 text-on-surface-variant">
          {result.preview}
        </p>
      )}

      <div className="mt-5 space-y-3">
        {result.metadata.map(([label, value]) => (
          <div key={label} className="border-b border-[var(--ghost-border)] pb-3 last:border-b-0 last:pb-0">
            <div className="text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">
              {label}
            </div>
            <div className="mt-1 break-words text-sm text-on-surface">{value}</div>
          </div>
        ))}
        {result.projectWorkerUrl && (
          <div className="border-b border-[var(--ghost-border)] pb-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-on-surface-variant">
              Source Worker
            </div>
            <div className="mt-1 break-all text-sm text-on-surface">{result.projectWorkerUrl}</div>
          </div>
        )}
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        {result.deepLink && (
          <Button asChild={false} variant="secondary" onClick={() => window.open(result.deepLink!, '_blank', 'noopener,noreferrer')}>
            <ExternalLink className="mr-2 h-4 w-4" />
            Open source detail
          </Button>
        )}
      </div>

      <details className="mt-5 rounded-md border border-[var(--ghost-border)] bg-surface-container-low p-4">
        <summary className="cursor-pointer text-sm text-on-surface">View raw record</summary>
        <pre className="mt-4 overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-surface-container-lowest p-4 font-mono text-xs text-on-surface">
          {JSON.stringify(result.raw, null, 2)}
        </pre>
      </details>
    </Container>
  );
}
