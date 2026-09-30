import { Card, ErrorState, HealthDot, LoadingState, StatusChip } from '../../../design';
import type { useStatus } from '../../../hooks/use-status';
import type { StatusResponse } from '../../../lib/api';
import { formatCount } from '../../../lib/format';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { ago } from '../../today/words';
import { AdminSection, RowCard } from '../AdminFrame';
import { backlogWords, capabilityWords } from './words';

export interface StatusSectionProps {
  status: ReturnType<typeof useStatus>;
  now: number;
  projectName: (projectId: string) => string | null;
}

/** Whether the database is at the schema this server expects, in one line. */
function schemaLine(schema: StatusResponse['schema']): { tone: 'ok' | 'bad'; words: string } {
  if (schema.matches) return { tone: 'ok', words: `The database is at the version this server expects (${schema.expected}).` };
  if (schema.found === null) return { tone: 'bad', words: 'The database could not be reached.' };
  return { tone: 'bad', words: `The database holds version ${schema.found}; this server expects ${schema.expected}. Some pages may fail until they match.` };
}

/**
 * Status: whether the database matches this server, what the server itself
 * can run, what each project last sent, and the transcripts still waiting to
 * be read. A project is named by its name, never its id.
 */
export function StatusSection({ status, now, projectName }: StatusSectionProps) {
  const data = status.data;
  return (
    <AdminSection id={HEALTH_ANCHORS.status} title="Status" description="Whether this server is set up to hold memory, and what it has received.">
      {status.isPending ? <LoadingState label="Reading this server’s status" count={3} />
        : data === undefined ? <ErrorState error={status.error} onRetry={() => void status.refetch()} />
        : <StatusBody data={data} now={now} projectName={projectName} />}
    </AdminSection>
  );
}

function StatusBody({ data, now, projectName }: { data: StatusResponse; now: number; projectName: StatusSectionProps['projectName'] }) {
  const schema = schemaLine(data.schema);
  const backlog = backlogWords(data.transcriptBacklog);
  const projects = [...data.projects].sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1));
  return (
    <div className="flex flex-col gap-s4">
      <Card className="flex flex-col gap-s3" data-health-schema="">
        <p className="flex items-start gap-s2 t-body text-ink">
          <span className="flex h-lh shrink-0 items-center"><HealthDot tone={schema.tone} label={schema.tone === 'ok' ? 'Current' : 'Needs attention'} /></span>
          <span>{schema.words}</span>
        </p>
        {backlog !== null && <p className="t-small text-muted" data-testid="transcript-backlog">{backlog}</p>}
      </Card>

      <div className="flex flex-col gap-s2">
        <h3 className="t-h3 text-ink">What this server runs itself</h3>
        <p className="max-w-measure t-small text-muted">Machines running Myco’s work attach on their own and are listed under Workers.</p>
        {data.capabilities.length === 0 ? (
          <p className="t-small text-muted">This server reports nothing it runs itself.</p>
        ) : (
          <RowCard label="What this server runs itself">
            {data.capabilities.map((capability) => (
              <div key={capability.capability} className="flex min-h-row-tight items-center justify-between gap-s3 px-s4 py-s2">
                <span className="min-w-0 t-body text-ink-2">{capabilityWords(capability)}</span>
                <StatusChip tone={capability.present ? 'ok' : 'warn'}>{capability.present ? 'Set up' : 'Not set up'}</StatusChip>
              </div>
            ))}
          </RowCard>
        )}
      </div>

      <div className="flex flex-col gap-s2">
        <h3 className="t-h3 text-ink">What each project last sent</h3>
        {projects.length === 0 ? (
          <p className="t-small text-muted">Nothing has been received yet.</p>
        ) : (
          <RowCard label="What each project last sent">
            {projects.map((project) => (
              <div key={project.projectId} className="flex min-h-row-tight flex-wrap items-center justify-between gap-x-s3 gap-y-s1 px-s4 py-s2" data-health-project="">
                <span className="flex min-w-0 items-center gap-s2">
                  <span className="truncate t-body text-ink-2">{projectName(project.projectId) ?? 'A project'}</span>
                  {project.archivedAt != null && <StatusChip>Archived</StatusChip>}
                </span>
                <span className="t-small text-muted">
                  {formatCount(project.sessionCount, 'session')} · {project.lastActivityAt === null ? 'nothing yet' : `last ${ago(project.lastActivityAt, now)}`}
                </span>
              </div>
            ))}
          </RowCard>
        )}
      </div>
    </div>
  );
}
