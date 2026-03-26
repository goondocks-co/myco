import { useDaemon } from '../hooks/use-daemon';
import { PageLoading } from '../components/ui/page-loading';
import { StatusHero } from '../components/dashboard/StatusHero';
import { VaultStats } from '../components/dashboard/VaultStats';
import { SessionPodGrid } from '../components/dashboard/SessionPodGrid';
import { SporeChart } from '../components/dashboard/SporeChart';
import { ActivityLogFeed } from '../components/dashboard/ActivityLogFeed';
import { FooterStatus } from '../components/dashboard/FooterStatus';

export default function Dashboard() {
  const { data: stats, isLoading, isError, error } = useDaemon();

  return (
    <PageLoading
      isLoading={isLoading}
      error={isError ? (error instanceof Error ? error : new Error('Unable to reach daemon')) : null}
      loadingText="Connecting to daemon..."
    >
      {stats && (
        <div className="relative min-h-full">
          {/* Background mycelial decoration */}
          <div className="absolute inset-0 pointer-events-none opacity-[0.04]">
            <svg height="100%" width="100%" viewBox="0 0 800 800" preserveAspectRatio="none">
              <path
                className="mycelial-connector"
                d="M400 800C400 600 300 500 200 400C100 300 0 400 0 400"
                fill="none"
                stroke="#abcfb8"
                strokeWidth="1"
              />
              <path
                className="mycelial-connector"
                d="M400 800C400 600 500 500 600 400C700 300 800 400 800 400"
                fill="none"
                stroke="#abcfb8"
                strokeWidth="1"
              />
              <path
                className="mycelial-connector"
                d="M400 800C400 500 450 300 400 100"
                fill="none"
                stroke="#abcfb8"
                strokeWidth="1"
              />
            </svg>
          </div>

          {/* Content */}
          <div className="relative z-10 p-6 lg:p-8 max-w-7xl mx-auto space-y-10">
            {/* Hero banner */}
            <StatusHero stats={stats} />

            {/* Stat row */}
            <VaultStats stats={stats} />

            {/* Session pod cards */}
            <SessionPodGrid />

            {/* Visualization row: chart + logs */}
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              <SporeChart />
              <ActivityLogFeed />
            </section>

            {/* Footer status bar */}
            <FooterStatus stats={stats} />
          </div>
        </div>
      )}
    </PageLoading>
  );
}
