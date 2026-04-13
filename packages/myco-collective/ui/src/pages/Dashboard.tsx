import { useQueries, useQuery } from '@tanstack/react-query';
import { ArrowUpRight, KeyRound, Orbit, Package2, ShieldCheck } from 'lucide-react';
import { Card } from '../components/ui/card';
import { fetchHealth, fetchProjects, fetchSettings } from '../lib/api';

function formatTimestamp(value: number | null): string {
  if (!value) return 'Never';
  return new Date(value * 1000).toLocaleString();
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
  const settingCount = Object.keys(settingsQuery.data?.settings_records ?? {}).length;

  return (
    <div className="space-y-6">
      <section className="grid gap-4 xl:grid-cols-[1.2fr,0.8fr]">
        <Card className="overflow-hidden p-6 md:p-8">
          <div className="flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between">
            <div className="max-w-2xl">
              <p className="font-mono text-[11px] uppercase tracking-[0.34em] text-[#ceab91]">Dashboard</p>
              <h2 className="mt-4 font-display text-5xl leading-none text-[#fff4e8] md:text-[4.3rem]">
                Collective memory with an operator surface.
              </h2>
              <p className="mt-5 max-w-xl text-base leading-7 text-[#ccb6a6]">
                The control plane is now responsible for registration, settings distribution, and federated search. This view keeps the cross-project surface legible while the branch stays isolated in the worktree.
              </p>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[#9f8774]">Admin Auth</p>
                <p className="mt-3 text-xl text-[#fff1e3]">
                  {healthQuery.data?.admin_token_hash ? 'Provisioned' : 'Missing'}
                </p>
              </div>
              <div className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
                <p className="font-mono text-[11px] uppercase tracking-[0.26em] text-[#9f8774]">MCP Auth</p>
                <p className="mt-3 text-xl text-[#fff1e3]">
                  {healthQuery.data?.mcp_token_hash ? 'Provisioned' : 'Missing'}
                </p>
              </div>
            </div>
          </div>
        </Card>

        <Card className="p-6 md:p-8">
          <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-[#ceab91]">Current Pulse</p>
          <div className="mt-6 grid gap-4">
            <div className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#c9b09e]">Latest remote contact</span>
                <Orbit className="h-4 w-4 text-[#f7b36a]" />
              </div>
              <p className="mt-3 text-lg text-[#fff4e8]">{formatTimestamp(freshestProject?.last_seen ?? null)}</p>
            </div>
            <div className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-[#c9b09e]">Overrides in force</span>
                <ShieldCheck className="h-4 w-4 text-[#f7b36a]" />
              </div>
              <p className="mt-3 text-lg text-[#fff4e8]">{settingCount}</p>
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: 'Registered Projects', value: String(projects.length), icon: Package2 },
          { label: 'Settings Overrides', value: String(settingCount), icon: ShieldCheck },
          { label: 'Admin Token Hash', value: healthQuery.data?.admin_token_hash ?? 'Unavailable', icon: KeyRound },
          { label: 'MCP Token Hash', value: healthQuery.data?.mcp_token_hash ?? 'Unavailable', icon: ArrowUpRight },
        ].map(({ label, value, icon: Icon }) => (
          <Card key={label} className="p-5">
            <div className="flex items-center justify-between">
              <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#9f8774]">{label}</p>
              <Icon className="h-4 w-4 text-[#f7b36a]" />
            </div>
            <p className="mt-5 break-all text-2xl text-[#fff3e5]">{value}</p>
          </Card>
        ))}
      </section>

      <section className="grid gap-4 xl:grid-cols-[1fr,1fr]">
        <Card className="p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#9f8774]">Projects</p>
              <h3 className="mt-2 font-display text-3xl text-[#fff3e5]">Registered workers</h3>
            </div>
            <span className="rounded-full border border-[rgba(255,231,208,0.10)] px-3 py-1 font-mono text-[11px] uppercase tracking-[0.22em] text-[#d2b29a]">
              {projects.length} total
            </span>
          </div>

          <div className="mt-5 space-y-3">
            {projects.map((project) => (
              <div key={project.id} className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-lg text-[#fff0e2]">{project.name}</p>
                    <p className="text-sm text-[#b99f8c]">{project.worker_url}</p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {project.capabilities.map((capability) => (
                      <span key={capability} className="rounded-full bg-[rgba(247,179,106,0.12)] px-3 py-1 text-xs text-[#ffd6ad]">
                        {capability}
                      </span>
                    ))}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-[#9f8774]">Overrides</p>
          <h3 className="mt-2 font-display text-3xl text-[#fff3e5]">Active settings</h3>

          <div className="mt-5 space-y-3">
            {Object.entries(settingsQuery.data?.settings_records ?? {}).map(([key, record]) => (
              <div key={key} className="rounded-[24px] border border-[rgba(255,231,208,0.10)] bg-[rgba(255,248,240,0.04)] p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="font-mono text-xs uppercase tracking-[0.22em] text-[#f6c69b]">{key}</span>
                  <span className="text-xs text-[#9f8774]">{formatTimestamp(record.updated_at)}</span>
                </div>
                <pre className="mt-3 overflow-x-auto whitespace-pre-wrap break-words rounded-2xl bg-[rgba(8,4,3,0.42)] p-3 font-mono text-xs text-[#ffe9d0]">
                  {JSON.stringify(record.value, null, 2)}
                </pre>
              </div>
            ))}
          </div>
        </Card>
      </section>
    </div>
  );
}
