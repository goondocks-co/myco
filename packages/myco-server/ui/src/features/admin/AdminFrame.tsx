import { useEffect, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Card } from '../../design';
import { useIsAdmin } from '../../hooks/use-me';
import { cn } from '../../lib/cn';

export interface AdminPageProps {
  title: ReactNode;
  /** One line under the title on what the page is for. */
  lede?: ReactNode;
  /** The page's own actions, beside the title on a wide screen and under it on a phone. */
  actions?: ReactNode;
  /** Names the page for the screen checks, as `data-admin-page`. */
  name: string;
  children: ReactNode;
}

/**
 * An admin page's frame: the title, one line on what the page is for, the
 * page's actions, then its sections one under another.
 */
export function AdminPage({ title, lede, actions, name, children }: AdminPageProps) {
  return (
    <div className="flex w-full flex-col gap-s8" data-admin-page={name}>
      <header className="flex flex-col gap-s4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex min-w-0 flex-col gap-s2">
          <h1 className="t-display text-ink">{title}</h1>
          {lede != null && <p className="max-w-measure t-body text-muted">{lede}</p>}
        </div>
        {actions != null && <div className="flex shrink-0 flex-wrap gap-s2">{actions}</div>}
      </header>
      {children}
    </div>
  );
}

export interface AdminSectionProps {
  /** The section's anchor, which a link elsewhere may lead to with `#id`. */
  id: string;
  title: ReactNode;
  /** One line on what the section holds. */
  description?: ReactNode;
  /** The section's own actions, at the right of its heading. */
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** One section of an admin page: its heading, one line on what it holds, and its content. */
export function AdminSection({ id, title, description, actions, children, className }: AdminSectionProps) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className={cn('flex scroll-mt-s6 flex-col gap-s4', className)}>
      <div className="flex flex-wrap items-end justify-between gap-s3">
        <div className="flex min-w-0 flex-col gap-s1">
          <h2 id={`${id}-title`} className="t-h2 text-ink">{title}</h2>
          {description != null && <p className="max-w-measure t-small text-muted">{description}</p>}
        </div>
        {actions != null && <div className="flex shrink-0 flex-wrap gap-s2">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export interface SettingRowProps {
  /** The setting's name. With `htmlFor` it is the control's label. */
  label: ReactNode;
  htmlFor?: string;
  /** What the setting does, in one or two lines. */
  note?: ReactNode;
  /** Where the value stands: "Saved by Ada 2h ago", "Server default", or why a save was refused. */
  status?: ReactNode;
  /** Status reads as a refusal. */
  refused?: boolean;
  control: ReactNode;
  /** Puts the control under the words at full width, for a text box, a list or a document. */
  stacked?: boolean;
  /** Keeps a small control, such as a switch, beside the words at every width, a phone's included. */
  inline?: boolean;
  /** Names the row for tests and the screen checks, as `data-setting`. */
  setting?: string;
}

/**
 * One setting: its name, what it does and where its value stands, with the
 * control at the right, or under the words for a control that needs the width.
 * Rows stack into one column on a phone.
 */
export function SettingRow({ label, htmlFor, note, status, refused = false, control, stacked = false, inline = false, setting }: SettingRowProps) {
  const words = (
    <div className="flex min-w-0 flex-col gap-s1">
      {htmlFor != null
        ? <label htmlFor={htmlFor} className="t-body font-medium text-ink">{label}</label>
        : <span className="t-body font-medium text-ink">{label}</span>}
      {note != null && <p className="max-w-measure t-small text-muted">{note}</p>}
      {status != null && (
        <p role={refused ? 'alert' : undefined} className={cn('t-meta', refused ? 'text-bad' : 'text-faint')} data-setting-status={setting}>
          {status}
        </p>
      )}
    </div>
  );
  return (
    <div
      data-setting={setting}
      className={cn(
        'flex gap-s3 px-s4 py-s4',
        inline ? 'flex-row items-start justify-between gap-s4 sm:gap-s8' : 'flex-col',
        !stacked && !inline && 'sm:flex-row sm:items-start sm:justify-between sm:gap-s8',
      )}
    >
      {words}
      <div className={cn('flex min-w-0 items-center gap-s2', stacked ? 'w-full' : inline ? 'shrink-0 justify-end pt-s1 sm:w-select-wide' : 'sm:w-select-wide sm:shrink-0 sm:justify-end')}>
        {control}
      </div>
    </div>
  );
}

/** A card of setting rows or list rows, divided by lines, edge to edge. */
export function RowCard({ label, children, className }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <Card padding="flush" className={cn('flex flex-col divide-y divide-line', className)} aria-label={label} role={label != null ? 'group' : undefined}>
      {children}
    </Card>
  );
}

/** What a member who is not an admin sees in place of a page that only an admin uses. */
export const ADMIN_ONLY_WORDS = 'This page is for an admin of this server. Ask one to make the change.';

/**
 * A page only an admin uses. A member who is not one is told so, and none of
 * the page mounts, so nothing it would read is asked for.
 */
export function AdminOnly({ title, children }: { title: string; children: ReactNode }) {
  if (useIsAdmin()) return <>{children}</>;
  return (
    <div className="flex w-full flex-col gap-s6" data-admin-page="admin-only">
      <h1 className="t-display text-ink">{title}</h1>
      <Card className="flex flex-col gap-s2" data-testid="admin-only">
        <p className="t-body text-ink-2">{ADMIN_ONLY_WORDS}</p>
      </Card>
    </div>
  );
}

/**
 * Scrolls to the element the address's `#anchor` names once `ready` says the
 * page has drawn it, and again whenever the anchor changes.
 */
export function useAnchorScroll(ready: boolean): void {
  const { hash } = useLocation();
  useEffect(() => {
    if (!ready || hash.length < 2) return;
    const target = document.getElementById(decodeURIComponent(hash.slice(1)));
    target?.scrollIntoView?.({ block: 'start' });
  }, [ready, hash]);
}
