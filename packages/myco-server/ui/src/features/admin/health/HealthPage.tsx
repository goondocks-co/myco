import { Link as RouterLink } from 'react-router-dom';
import { focusRing } from '../../../design';
import { useAttention } from '../../../hooks/use-attention';
import { useBackups } from '../../../hooks/use-backups';
import { useNeedsYou } from '../../../hooks/use-needs-you';
import { useProjects } from '../../../hooks/use-projects';
import { useStatus } from '../../../hooks/use-status';
import { useNow } from '../../../hooks/use-today';
import { freshness } from '../../../hooks/use-work';
import { cn } from '../../../lib/cn';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { NeedsYouPanel } from '../../today/NeedsYou';
import { AdminPage, useAnchorScroll } from '../AdminFrame';
import { BackupsSection } from './BackupsSection';
import { MeasuresSection } from './MeasuresSection';
import { StatusSection } from './StatusSection';
import { UpkeepSection } from './UpkeepSection';
import { WorkersSection } from './WorkersSection';

/** The parts of Health, in the order the page lists them. */
const JUMPS: ReadonlyArray<{ anchor: string; label: string }> = [
  { anchor: HEALTH_ANCHORS.needsYou, label: 'Needs you' },
  { anchor: HEALTH_ANCHORS.status, label: 'Status' },
  { anchor: HEALTH_ANCHORS.workers, label: 'Workers' },
  { anchor: HEALTH_ANCHORS.backups, label: 'Backups' },
  { anchor: HEALTH_ANCHORS.upkeep, label: 'Upkeep' },
  { anchor: HEALTH_ANCHORS.measures, label: 'Measures' },
];

/**
 * `/status/health`: whether this server is well, what it is doing on its own,
 * and what needs an admin, on one page. Its status is read again every 30 s
 * while the tab is visible.
 */
export function HealthPage() {
  const now = useNow();
  const status = useStatus(freshness(true));
  const attention = useAttention({ enabled: true });
  const backups = useBackups();
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const projectName = (projectId: string): string | null => names.get(projectId) ?? null;
  const needsYou = useNeedsYou({ now, projectName });
  useAnchorScroll(!status.isPending && !attention.isPending && !backups.list.isPending);

  return (
    <AdminPage
      name="health"
      scope="server"
      title="Health"
      lede="Whether this server is well, what it does on its own, and anything that needs you."
    >
      <nav aria-label="Parts of Health" className="-mt-s4 flex gap-s2 overflow-x-auto pb-s1" data-health-jumps="">
        {JUMPS.map((jump) => (
          <RouterLink
            key={jump.anchor}
            to={`#${jump.anchor}`}
            className={cn(
              'inline-flex h-control-sm shrink-0 items-center whitespace-nowrap rounded-pill border border-line bg-surface-1 px-s3 t-small text-ink-2',
              'transition-colors duration-120 hover:bg-surface-2 hover:text-ink',
              focusRing,
            )}
          >
            {jump.label}
          </RouterLink>
        ))}
      </nav>
      <section id={HEALTH_ANCHORS.needsYou} aria-label="Needs you" className="scroll-mt-s6">
        <NeedsYouPanel {...needsYou} />
      </section>
      <StatusSection status={status} now={now} projectName={projectName} />
      <WorkersSection status={status} now={now} projectName={projectName} />
      <BackupsSection />
      <UpkeepSection />
      <MeasuresSection />
    </AdminPage>
  );
}
