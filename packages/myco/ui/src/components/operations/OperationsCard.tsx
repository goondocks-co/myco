import { type ReactNode } from 'react';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { ScopeBadge } from '../config/ScopePill';
import { SCOPE_HELPER_TEXT, type SectionScope } from './scope-helpers';

export interface OperationsCardProps {
  title: string;
  /** Data scope for this card; renders an inline chip + helper line. */
  scope?: SectionScope;
  /** Right-aligned chip rendered next to the title (status pill, etc). */
  meta?: ReactNode;
  loading: boolean;
  error: Error | null;
  empty: boolean;
  emptyText: string;
  children: ReactNode;
}

export function OperationsCard({
  title,
  scope,
  meta,
  loading,
  error,
  empty,
  emptyText,
  children,
}: OperationsCardProps) {
  const titleNode = (
    <div className="flex items-center gap-2">
      <SectionHeader>{title}</SectionHeader>
      {scope && <ScopeBadge scope={scope} />}
    </div>
  );

  if (loading) {
    return (
      <Surface level="low" className="p-6 space-y-3">
        {titleNode}
        <p className="font-sans text-sm text-on-surface-variant">Loading…</p>
      </Surface>
    );
  }

  if (error) {
    return (
      <Surface level="low" className="p-6 space-y-3">
        {titleNode}
        <p className="font-sans text-sm text-tertiary">
          Failed to load: {error.message}
        </p>
      </Surface>
    );
  }

  if (empty) {
    return (
      <Surface level="low" className="p-6 space-y-3">
        {titleNode}
        <p className="font-sans text-sm text-on-surface-variant">{emptyText}</p>
      </Surface>
    );
  }

  return (
    <Surface level="low" className="p-6 space-y-4">
      <div className="flex items-center justify-between">
        {titleNode}
        {meta}
      </div>
      {scope && (
        <p className="font-sans text-xs text-on-surface-variant">{SCOPE_HELPER_TEXT[scope]}</p>
      )}
      {children}
    </Surface>
  );
}

/** Two-column row used by the operations cards: title block on the left, stats on the right. */
export function OperationsRow({
  primary,
  meta,
}: {
  primary: ReactNode;
  meta: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 rounded-md bg-surface-container-low/40 p-3">
      <div className="min-w-0 space-y-1">{primary}</div>
      <div className="flex flex-col items-end gap-0.5 text-right font-sans text-xs">{meta}</div>
    </div>
  );
}
