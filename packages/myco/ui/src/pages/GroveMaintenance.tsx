import { useState, useCallback } from 'react';
import { PageHeader } from '../components/ui/page-header';
import { EmbeddingTab } from '../components/operations/EmbeddingTab';
import { DatabaseTab } from '../components/operations/DatabaseTab';
import type { Tab } from '../components/ui/tab-switcher';

/* ---------- Tabs ---------- */

type ActiveTab = 'embedding' | 'database';

const MAINTENANCE_TABS: Tab[] = [
  { id: 'embedding', label: 'Embedding' },
  { id: 'database', label: 'Database' },
];

const VALID_TABS = new Set<ActiveTab>(['embedding', 'database']);

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

/* ---------- Grove Maintenance Page ---------- */

const TAB_SUBTITLES: Record<ActiveTab, string> = {
  embedding: 'Embedding actions for this Grove',
  database: 'Database actions and scheduled maintenance',
};

export default function GroveMaintenance() {
  const [activeTab, setActiveTab] = useState<ActiveTab>(readTabFromUrl);

  const handleTabChange = useCallback((tabId: string) => {
    const tab = tabId as ActiveTab;
    setActiveTab(tab);
    writeTabToUrl(tab);
  }, []);

  // Each tab owns its own data fetch — Embedding fetches namespace
  // counts (scope-driven), Database fetches schema details, Backup
  // queries the backup list. Lifting them used to share a loading
  // gate at the page level but kept the Embedding fetch tied to
  // 'project' scope no matter what the namespace pill was set to.
  return (
    <div className="flex h-full flex-col">
      <div className="px-6 pt-6">
        <PageHeader
          title="Grove maintenance"
          subtitle={TAB_SUBTITLES[activeTab]}
          tabs={MAINTENANCE_TABS}
          activeTab={activeTab}
          onTabChange={handleTabChange}
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
