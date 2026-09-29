import type { ReactNode } from 'react';
import { useIsAdmin } from '../hooks/use-me';
import { Panel } from './ui/panel';

/** What a member who is not an admin sees in place of a page that only an admin uses. */
export const ADMIN_ONLY_WORDS = 'This is for an admin of this server. Ask one to make the change.';

/** A page, or part of one, that only an admin uses: a member who is not one is shown why instead of controls the server refuses them. */
export function AdminOnly({ title, children }: { title: string; children: ReactNode }) {
  if (useIsAdmin()) return <>{children}</>;
  return (
    <Panel title={title} data-testid="admin-only">
      <p className="font-sans text-sm text-on-surface-variant">{ADMIN_ONLY_WORDS}</p>
    </Panel>
  );
}
