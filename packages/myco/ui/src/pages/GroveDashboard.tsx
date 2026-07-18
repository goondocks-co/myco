import { useProjectSelection } from '../hooks/use-project-selection';
import { useDaemon } from '../hooks/use-daemon';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { PageContainer } from '../components/ui/page-container';
import { GroveIdentityCard } from '../components/grove/GroveIdentityCard';
import { DaemonStatusCard } from '../components/grove/DaemonStatusCard';
import { GroveProjectsPanel } from '../components/grove/GroveProjectsPanel';
import { GroveActiveNowPanel } from '../components/grove/GroveActiveNowPanel';
import { GroveVaultSummary } from '../components/grove/GroveVaultSummary';
import { GroveBackupSnapshot } from '../components/grove/GroveBackupSnapshot';
import { CrossGrovePeek } from '../components/grove/CrossGrovePeek';

export default function GroveDashboard() {
  const selection = useProjectSelection();
  const { data: daemon } = useDaemon();

  if (!selection || !daemon) {
    return (
      <PageLoading isLoading error={null} loadingText="Loading Grove…">
        <span />
      </PageLoading>
    );
  }

  const grove = selection.grove;

  return (
    <PageContainer>
      <PageHeader
        title={grove.name}
        subtitle="Database boundary for this set of projects. Embedding, vault, backups, and team sync are all Grove-scoped."
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <GroveIdentityCard
          name={grove.name}
          slug={grove.slug}
          projectCount={grove.project_count ?? 0}
          machineId={daemon.context.request.machine_id}
        />
        <DaemonStatusCard
          uptimeSeconds={daemon.daemon.uptime_seconds}
          port={daemon.daemon.port}
          version={daemon.daemon.version}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <GroveProjectsPanel groveSlug={grove.slug} />
        <GroveActiveNowPanel groveSlug={grove.slug} />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <GroveVaultSummary groveSlug={grove.slug} />
        <GroveBackupSnapshot />
      </div>

      <CrossGrovePeek currentGroveSlug={grove.slug} />
    </PageContainer>
  );
}
