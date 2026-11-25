import { ActionLink, buttonVariants, Card, Link } from '../../../design';
import { useAttention } from '../../../hooks/use-attention';
import { useAgentPayers } from '../../../hooks/use-fleet';
import { useWorkNow } from '../../../hooks/use-live';
import { useNeedsYou } from '../../../hooks/use-needs-you';
import { useProjects } from '../../../hooks/use-projects';
import { useStatus } from '../../../hooks/use-status';
import { useNow } from '../../../hooks/use-today';
import { cn } from '../../../lib/cn';
import { BACKUPS_ADDRESS, HEALTH_ANCHORS, MEASURES_PATH, UPKEEP_ADDRESS, WORK_SUFFIX } from '../../../routes/nav';
import { NeedsYouPanel } from '../../today/NeedsYou';
import { needsItems } from '../../today/server-items';
import { AdminPage, useAnchorScroll } from '../AdminFrame';
import { ServerWell } from './ServerWell';
import type { HealthFacts } from './verdict';

/**
 * `/status/health`: two questions. Is the server well, as one verdict over five lines; and what needs you, each item
 * with a way to finish it. The diagnostics file for an issue is at the foot. What Myco is doing is on Myco's work;
 * backups and upkeep are under Settings › Advanced, and whether Myco is helping has its own page.
 */
export function HealthPage() {
  const now = useNow();
  const status = useStatus();
  const projects = useProjects();
  const names = new Map((projects.data?.projects ?? []).map((p) => [p.projectId, p.name]));
  const projectName = (projectId: string): string | null => names.get(projectId) ?? null;
  const needsYou = useNeedsYou({ now, projectName });
  const attention = useAttention({ enabled: true });
  const work = useWorkNow(null);
  const payers = useAgentPayers();
  const read = <T,>(query: { data: T | undefined; error: unknown }) => ({ data: query.data, failed: query.error !== null });
  const facts: HealthFacts = {
    now, projectName, status: read(status), attention: read(attention), work: read(work), payers: read(payers),
    server: needsItems((attention.data?.items ?? []), needsYou.server.items).server, unchecked: needsYou.server.unchecked,
  };
  useAnchorScroll(!status.isPending && !needsYou.pending);
  const retry = () => { void status.refetch(); void attention.refetch(); void work.refetch(); void payers.refetch(); needsYou.onRetry(); };

  return (
    <AdminPage
      name="health"
      scope="server"
      title="Health"
      lede="Whether this server is well, and anything that needs you."
      actions={<ActionLink to={WORK_SUFFIX}>What Myco is doing, and its runners →</ActionLink>}
    >
      <ServerWell facts={facts} reading={status.isPending} onRetry={retry} />
      <section id={HEALTH_ANCHORS.needsYou} aria-label="What needs you" className="scroll-mt-s6">
        <NeedsYouPanel {...needsYou} title="What needs you" />
      </section>
      <div className="flex flex-col gap-s2">
        <Card className="flex flex-wrap items-start justify-between gap-s3" data-testid="diagnostics">
          <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-s1">
            <h2 className="t-body font-medium text-ink">Something wrong that isn’t listed?</h2>
            <p className="max-w-measure t-small text-muted">
              One file describing this server, to attach to an issue: its schema, what it is set up to run, the machines running its work, the tasks waiting, and what each project last sent.
              It carries no keys, no captured content and no error messages. On your own machine, <code className="t-mono">myco member export</code> writes the matching half.
            </p>
          </div>
          <a className={cn(buttonVariants({ size: 'sm' }), 'shrink-0')} href="/api/diagnostics" download data-testid="download-diagnostics">Download diagnostics</a>
        </Card>
        <p className="t-small text-muted" data-health-moved="">
          Backups and upkeep are in Settings › Advanced: <Link to={BACKUPS_ADDRESS}>Backups</Link>, <Link to={UPKEEP_ADDRESS}>Upkeep</Link>. How much Myco is used is on <Link to={MEASURES_PATH}>Is Myco helping?</Link>
        </p>
      </div>
    </AdminPage>
  );
}
