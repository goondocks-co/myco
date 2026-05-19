import { cn } from '../../lib/cn';

/*
 * Inline pill row used as the sub-tab control under a TileTabs row — e.g.
 * Cortex > Canopy then Settings / Entries / Map.
 */

export interface SubtabPillItem {
  id: string;
  label: string;
  count?: number;
}

export interface SubtabPillProps {
  tabs: SubtabPillItem[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
}

export function SubtabPill({ tabs, activeTab, onTabChange, className }: SubtabPillProps) {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 p-1 rounded-md bg-surface-container-low border border-[var(--ghost-border)]',
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
              'inline-flex items-center gap-1.5 px-3 py-1 rounded text-sm font-sans transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sage/40',
              isActive
                ? 'bg-surface-container text-on-surface shadow-[inset_0_-2px_0_var(--sage)]'
                : 'text-on-surface-variant hover:text-on-surface',
            )}
          >
            <span>{tab.label}</span>
            {tab.count != null && (
              <span className="font-mono text-[10px] text-outline">{tab.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
