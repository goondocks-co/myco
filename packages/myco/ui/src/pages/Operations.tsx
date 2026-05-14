import { useState, useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { PageHeader } from '../components/ui/page-header';
import { Button } from '../components/ui/button';
import { EmbeddingTab } from '../components/operations/EmbeddingTab';
import { DatabaseTab } from '../components/operations/DatabaseTab';
import type { Tab } from '../components/ui/tab-switcher';

type ActiveTab = 'embedding' | 'database';

const OPERATIONS_TABS: Tab[] = [
  { id: 'embedding', label: 'Embedding' },
  { id: 'database', label: 'Database' },
];

const VALID_TABS = new Set<ActiveTab>(['embedding', 'database']);

const TAB_SUBTITLES: Record<ActiveTab, string> = {
  embedding: 'Provider, queues, namespaces. Each action runs against the active Grove.',
  database: 'File health, tables, schedule, and on-demand maintenance for this Grove’s SQLite store.',
};

const PARAM_TAB = 'tab';

function readTabFromUrl(): ActiveTab {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get(PARAM_TAB);
  return raw && VALID_TABS.has(raw as ActiveTab) ? (raw as ActiveTab) : 'embedding';
}

function writeTabToUrl(tab: ActiveTab): void {
  const params = new URLSearchParams();
  if (tab !== 'embedding') params.set(PARAM_TAB, tab);
  const search = params.toString();
  const url = search ? `${window.location.pathname}?${search}` : window.location.pathname;
  window.history.replaceState(null, '', url);
}

export default function Operations() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromUrl);

  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as ActiveTab;
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  const handleRefresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['embedding-details'] });
    queryClient.invalidateQueries({ queryKey: ['database-details'] });
  }, [queryClient]);

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Operations"
          subtitle={TAB_SUBTITLES[activeTab]}
          tabs={OPERATIONS_TABS}
          activeTab={activeTab}
          onTabChange={handleTabChange}
          actions={
            <Button variant="ghost" size="sm" onClick={handleRefresh}>
              <RefreshCw size={14} />
              Refresh
            </Button>
          }
        />
      </div>

      <div className="flex-1 overflow-auto">
        <div className="px-6 pb-6">
          {activeTab === 'embedding' && <EmbeddingTab />}
          {activeTab === 'database' && <DatabaseTab />}
        </div>
      </div>
    </div>
  );
}
