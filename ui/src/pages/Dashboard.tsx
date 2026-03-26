import { useState } from 'react';
import { useDaemon } from '../hooks/use-daemon';
import { PageLoading } from '../components/ui/page-loading';
import { PageHeader } from '../components/ui/page-header';
import { ActivityFeed } from '../components/dashboard/ActivityFeed';
import { SystemStatus } from '../components/dashboard/SystemStatus';
import { StatCards } from '../components/dashboard/StatCards';
import type { Tab } from '../components/ui/tab-switcher';

/* ---------- Constants ---------- */

const DASHBOARD_TABS: Tab[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
];

const ACTIVITY_TAB_LIMIT = 100;

/* ---------- Component ---------- */

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useDaemon();
  const [activeTab, setActiveTab] = useState('overview');

  const subtitle = stats
    ? `${stats.vault.session_count} sessions, ${stats.vault.spore_count} spores, ${stats.vault.entity_count} entities`
    : 'Connecting...';

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <div className="p-6">
          <PageHeader
            title="Dashboard"
            subtitle={subtitle}
            tabs={DASHBOARD_TABS}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />

          {activeTab === 'overview' && (
            <div className="space-y-6">
              <StatCards stats={stats} />

              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="lg:col-span-2">
                  <ActivityFeed />
                </div>
                <div>
                  <SystemStatus stats={stats} />
                </div>
              </div>
            </div>
          )}

          {activeTab === 'activity' && (
            <ActivityFeed limit={ACTIVITY_TAB_LIMIT} showHeader={false} />
          )}
        </div>
      )}
    </PageLoading>
  );
}
