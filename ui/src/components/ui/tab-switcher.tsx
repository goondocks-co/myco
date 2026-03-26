import { cn } from '../../lib/cn';

export interface Tab {
  id: string;
  label: string;
}

interface TabSwitcherProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (tabId: string) => void;
  className?: string;
}

export function TabSwitcher({ tabs, activeTab, onTabChange, className }: TabSwitcherProps) {
  return (
    <div className={cn('flex items-center gap-6', className)}>
      {tabs.map((tab) => (
        <button
          key={tab.id}
          onClick={() => onTabChange(tab.id)}
          className={cn(
            'pb-2 font-sans text-sm font-medium transition-colors border-b-2',
            activeTab === tab.id
              ? 'text-primary border-primary'
              : 'text-on-surface-variant border-transparent hover:text-on-surface',
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
