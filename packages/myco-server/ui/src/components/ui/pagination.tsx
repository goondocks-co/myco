import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from './button';

export interface PaginationProps {
  total: number;
  offset: number;
  limit: number;
  onPageChange: (newOffset: number) => void;
}

export function Pagination({ total, offset, limit, onPageChange }: PaginationProps) {
  const totalPages = Math.ceil(total / limit);
  if (totalPages <= 1) return null;

  const hasPrev = offset > 0;
  const hasNext = offset + limit < total;
  const rangeStart = offset + 1;
  const rangeEnd = Math.min(offset + limit, total);

  return (
    <div className="flex items-center justify-center gap-3 pt-1">
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasPrev}
        onClick={() => onPageChange(Math.max(0, offset - limit))}
        className="gap-1 text-on-surface-variant"
      >
        <ChevronLeft className="h-4 w-4" />
        Prev
      </Button>
      <span className="font-mono text-xs text-on-surface-variant">
        {rangeStart}&ndash;{rangeEnd} of {total}
      </span>
      <Button
        variant="ghost"
        size="sm"
        disabled={!hasNext}
        onClick={() => onPageChange(offset + limit)}
        className="gap-1 text-on-surface-variant"
      >
        Next
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  );
}
