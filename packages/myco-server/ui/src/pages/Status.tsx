import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { StatusDot } from '../components/ui/status-dot';
import { useStatus } from '../hooks/use-status';
import { formatCount, formatRelative } from '../lib/format';

export function Status() {
  const status = useStatus();
  const data = status.data;

  return (
    <PageContainer>
      <PageHeader title="Status" subtitle="Whether this server is set up to hold memory, and what it has received." />
      <PageLoading isLoading={status.isPending} error={status.error}>
        {data && (
          <div className="flex flex-col gap-4">
            <Panel padded title="Database" tone={data.schema.matches ? 'sage' : 'terra'}>
              <div className="flex items-center gap-2 font-sans text-sm text-on-surface">
                <StatusDot tone={data.schema.matches ? 'sage' : 'terracotta'} />
                {data.schema.matches
                  ? `Schema is current (version ${data.schema.expected}).`
                  : data.schema.found === null
                    ? 'The database is not reachable.'
                    : `Schema is version ${data.schema.found}; this server needs ${data.schema.expected}.`}
              </div>
            </Panel>

            <Panel padded title="Capabilities">
              <ul className="flex flex-col gap-2" aria-label="Capabilities">
                {data.capabilities.map((c) => (
                  <li key={c.capability} className="flex items-center gap-2 font-sans text-sm">
                    <StatusDot tone={c.present ? 'sage' : 'terracotta'} />
                    <span className="text-on-surface">{c.label}</span>
                    <span className="text-on-surface-variant">{c.present ? 'configured' : 'not configured'}</span>
                    <span className="ml-auto font-mono text-[11px] text-on-surface-variant/70">{c.operatorNames.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </Panel>

            <Panel padded title="Last received">
              {data.projects.length === 0 ? (
                <p className="font-sans text-sm text-on-surface-variant">Nothing has been received yet.</p>
              ) : (
                <table className="w-full font-sans text-sm">
                  <thead className="text-left text-[11px] uppercase tracking-wide text-on-surface-variant">
                    <tr><th className="py-1">Project</th><th className="py-1">Sessions</th><th className="py-1">Last received</th></tr>
                  </thead>
                  <tbody>
                    {data.projects.map((p) => (
                      <tr key={p.projectId} className="border-t border-outline-variant/10">
                        <td className="py-1.5 font-mono text-xs text-on-surface">{p.projectId}{p.archivedAt != null && <span className="ml-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">archived</span>}</td>
                        <td className="py-1.5 text-on-surface-variant">{formatCount(p.sessionCount, 'session')}</td>
                        <td className="py-1.5 text-on-surface-variant">{formatRelative(p.lastActivityAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Panel>
          </div>
        )}
      </PageLoading>
    </PageContainer>
  );
}
