import { type ReactNode } from 'react';
import { cn } from '../../lib/cn';
import { TabSwitcher, type Tab } from './tab-switcher';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  tabs?: Tab[];
  activeTab?: string;
  onTabChange?: (tabId: string) => void;
  actions?: ReactNode;
  className?: string;
}

export function PageHeader({
  title,
  subtitle,
  tabs,
  activeTab,
  onTabChange,
  actions,
  className,
}: PageHeaderProps) {
  return (
    <div className={cn('pb-6', className)}>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-serif text-2xl font-normal text-on-surface tracking-wide">
            {title}
          </h1>
          {subtitle && (
            <p className="mt-1 font-sans text-sm text-on-surface-variant">{subtitle}</p>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {tabs && activeTab && onTabChange && (
        <TabSwitcher
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={onTabChange}
          className="mt-4"
        />
      )}
    </div>
  );
}
