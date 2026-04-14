import { AlertTriangle } from 'lucide-react';
import { Card } from '../ui/card';
import { SectionHeader } from '../ui/section-header';
import type { SearchResponse } from '../../lib/types';

interface SearchFailureCardProps {
  errors: NonNullable<SearchResponse['errors']>;
}

export function SearchFailureCard({ errors }: SearchFailureCardProps) {
  if (errors.length === 0) return null;

  return (
    <Card className="border-tertiary/25 bg-tertiary/10 p-5">
      <div className="flex items-center gap-3">
        <AlertTriangle className="h-5 w-5 text-tertiary" />
        <div>
          <SectionHeader className="text-tertiary">Partial Failures</SectionHeader>
          <h3 className="mt-2 font-serif text-2xl text-on-surface">Some projects did not respond</h3>
        </div>
      </div>
      <div className="mt-4 space-y-3">
        {errors.map((error) => (
          <div
            key={`${error.project.id}-${error.error}`}
            className="rounded-2xl border border-tertiary/20 bg-surface-container-low px-4 py-3"
          >
            <div className="text-sm text-on-surface">{error.project.name}</div>
            <div className="mt-1 text-sm text-on-surface-variant">
              {error.error}
              {error.status ? ` (status ${error.status})` : ''}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
