import { useQueries, useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { Badge } from '../components/ui/badge';
import { Card } from '../components/ui/card';
import { PageHeader } from '../components/ui/page-header';
import { SectionHeader } from '../components/ui/section-header';
import { fetchHealth, fetchProjects, fetchSettings } from '../lib/api';
import { formatTimestamp } from '../lib/format';

function StatTile({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card className="p-5">
      <SectionHeader>{label}</SectionHeader>
      <div className="mt-3 font-serif text-2xl text-on-surface">{value}</div>
      {hint && <p className="mt-2 text-sm text-on-surface-variant">{hint}</p>}
    </Card>
  );
}

export default function Dashboard() {
  const [healthQuery, settingsQuery] = useQueries({
    queries: [
      { queryKey: ['health'], queryFn: fetchHealth },
      { queryKey: ['settings'], queryFn: fetchSettings },
    ],
  });
  const projectsQuery = useQuery({ queryKey: ['projects'], queryFn: fetchProjects });

  const projects = projectsQuery.data?.projects ?? [];
  const freshestProject = [...projects].sort((left, right) => (right.last_seen ?? 0) - (left.last_seen ?? 0))[0] ?? null;
  const records = settingsQuery.data?.settings_records ?? {};
  const recordEntries = Object.entries(records);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Dashboard"
        title="Cross-project visibility without leaving the Collective."
        subtitle="Hosted coordination for connected team workers, shared overrides, and federated memory search."
        actions={(
          <div className="flex flex-wrap gap-2">
            <Badge variant={healthQuery.data?.admin_token_hash ? 'accent' : 'danger'}>
              Admin {healthQuery.data?.admin_token_hash ? 'Ready' : 'Missing'}
            </Badge>
            <Badge variant={healthQuery.data?.mcp_token_hash ? 'accent' : 'danger'}>
              MCP {healthQuery.data?.mcp_token_hash ? 'Ready' : 'Missing'}
            </Badge>
          </div>
        )}
      />

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatTile
          label="Registered Projects"
          value={String(projects.length)}
          hint={projects.length === 1 ? 'One connected team worker.' : 'Connected team workers.'}
        />
        <StatTile
          label="Settings Overrides"
          value={String(recordEntries.length)}
          hint="Schema-backed settings currently distributed by the Collective."
        />
        <StatTile
          label="Latest Remote Contact"
          value={formatTimestamp(freshestProject?.last_seen)}
          hint={freshestProject ? freshestProject.name : 'No active projects yet.'}
        />
        <StatTile
          label="Collective Status"
          value={healthQuery.data?.status ?? 'unknown'}
          hint="Health endpoint summary for the hosted control plane."
        />
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.15fr,0.85fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between gap-4">
            <div>
              <SectionHeader>Projects</SectionHeader>
              <h2 className="mt-2 font-serif text-2xl text-on-surface">Connected workers</h2>
            </div>
            <Badge variant="subtle">{projects.length} total</Badge>
          </div>

          <div className="mt-5 space-y-3">
            {projects.map((project) => (
              <div
                key={project.id}
                className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low px-4 py-4"
              >
                <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0">
                    <div className="text-base font-medium text-on-surface">{project.name}</div>
                    <div className="mt-1 break-all text-sm text-on-surface-variant">
                      {project.worker_url}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {project.capabilities.map((capability) => (
                        <Badge key={capability} variant="subtle">
                          {capability}
                        </Badge>
                      ))}
                    </div>
                  </div>
                  <div className="grid shrink-0 gap-1 text-sm text-on-surface-variant lg:text-right">
                    <div>Package {project.package_version ?? 'unknown'}</div>
                    <div>Schema {project.schema_version ?? 'unknown'}</div>
                    <div>Seen {formatTimestamp(project.last_seen)}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-3">
            <Sparkles className="h-5 w-5 text-primary" />
            <div>
              <SectionHeader>Overrides</SectionHeader>
              <h2 className="mt-2 font-serif text-xl text-on-surface">Recently updated</h2>
            </div>
          </div>
          <div className="mt-5 space-y-3">
            {recordEntries.slice(0, 4).map(([key, record]) => (
              <div
                key={key}
                className="rounded-md border border-[var(--ghost-border)] bg-surface-container-low px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate font-mono text-[11px] uppercase tracking-[0.22em] text-primary">
                      {key}
                    </div>
                    <div className="mt-1 truncate text-sm text-on-surface-variant">
                      {record.description ?? 'No description provided.'}
                    </div>
                  </div>
                  <div className="shrink-0 text-xs text-on-surface-variant">
                    {formatTimestamp(record.updated_at)}
                  </div>
                </div>
              </div>
            ))}
            {recordEntries.length === 0 && (
              <div className="rounded-md border border-dashed border-[var(--ghost-border)] px-4 py-6 text-sm text-on-surface-variant">
                No overrides yet.
              </div>
            )}
          </div>
        </Card>
      </section>
    </div>
  );
}
