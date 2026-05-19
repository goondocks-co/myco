import { type ReactNode } from 'react';

export interface DefRowProps {
  term: ReactNode;
  children: ReactNode;
}

/**
 * Single key/value row inside a description list (`<dl>`). The four Grove
 * identity-strip cards each used to ship their own copy of this two-cell
 * layout — keep one canonical so future tweaks land everywhere.
 */
export function DefRow({ term, children }: DefRowProps) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-on-surface-variant">{term}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
}
