import { type LucideIcon } from 'lucide-react';
import { cn } from '../../lib/cn';

/*
 * Vertical "tile" tab pattern from `.myco-cortex-tabs` in styles-v4.css:
 *   - 2/3/4 column grid divided by ghost-border lines
 *   - Each tab stacks an italic serif label + mono uppercase description
 *   - Active tab gets a 2px sage top stripe + surface-container background
 *   - At ≤880px the grid collapses to one column
 *
 * Used as the page-level tab nav for Cortex, Agent, and Skills.
 */

export interface TileTab {
  id: string;
  label: string;
  description?: string;
  Icon?: LucideIcon;
}

export interface TileTabsProps {
  tabs: TileTab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  /** Number of columns; defaults to tabs.length, clamped to 2–4. */
  columns?: 2 | 3 | 4;
  className?: string;
}

const COLUMN_CLASS: Record<2 | 3 | 4, string> = {
  2: 'grid-cols-1 md:grid-cols-2',
  3: 'grid-cols-1 md:grid-cols-3',
  4: 'grid-cols-1 md:grid-cols-2 lg:grid-cols-4',
};

function resolveColumns(explicit: 2 | 3 | 4 | undefined, tabsLength: number): 2 | 3 | 4 {
  if (explicit) return explicit;
  if (tabsLength <= 2) return 2;
  if (tabsLength === 3) return 3;
  return 4;
}

export function TileTabs({
  tabs,
  activeTab,
  onTabChange,
  columns,
  className,
}: TileTabsProps) {
  const cols = resolveColumns(columns, tabs.length);
  return (
    <div
      role="tablist"
      className={cn(
        'grid divide-y md:divide-y-0 md:divide-x divide-[var(--ghost-border)] border border-[var(--ghost-border)] rounded-md overflow-hidden bg-surface-container-low',
        COLUMN_CLASS[cols],
        className,
      )}
    >
      {tabs.map((tab) => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={isActive}
            onClick={() => onTabChange(tab.id)}
            className={cn(
              'relative flex flex-col items-start gap-1 px-4 py-3 text-left transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40',
              isActive
                ? 'bg-surface-container text-on-surface'
                : 'text-on-surface-variant hover:bg-surface-container/60 hover:text-on-surface',
            )}
          >
            {isActive && (
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-[2px] bg-sage"
              />
            )}
            <div className="flex items-center gap-2">
              {tab.Icon && <tab.Icon size={14} className={isActive ? 'text-sage' : 'text-outline'} />}
              <span className="myco-display-xs">{tab.label}</span>
            </div>
            {tab.description && (
              <span className="myco-eyebrow-sm">{tab.description}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
