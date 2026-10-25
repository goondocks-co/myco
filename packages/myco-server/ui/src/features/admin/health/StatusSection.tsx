import { QueueWarning } from '../runners/QueueWarning';
import { Card, HealthDot, StatusChip, ReadState, ReadUnavailable } from '../../../design';
import type { useStatus } from '../../../hooks/use-status';
import type { StatusResponse } from '../../../lib/api';
import { formatCount,formatBytes } from '../../../lib/format';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { useAttention } from '../../../hooks/use-attention';
import { ago, transcriptStopWords, harnessHealthWords } from '../../today/words';
import { AdminSection, RowCard } from '../AdminFrame';
import { backlogWords, capabilityWords } from './words';
import { useEmbeddingSwitch, usePassedOver } from '../../../hooks/use-settings';
import { EmbeddingSwitchPanel, PassedOverSources } from '../settings/EmbeddingSwitch';

const VIEW_STATUS_SESSION_LIMIT=8;

export interface StatusSectionProps {
  status: ReturnType<typeof useStatus>;
  now: number;
  projectName: (projectId: string) => string | null;
}

/** Whether the database is at the schema this server expects, in one line. */
function schemaLine(schema: StatusResponse['schema']): { tone: 'ok' | 'bad'; words: string } {
  if (schema.matches) return { tone: 'ok', words: `The database is at the version this server expects (${schema.expected}).` };
  if (schema.found === null) return { tone: 'bad', words: 'The database version could not be read.' };
  return { tone: 'bad', words: `The database holds version ${schema.found}; this server expects ${schema.expected}. Some pages may fail until they match.` };
}

/**
 * Search by meaning: a switch of the embedding model under way, with how far rebuilding search has come, and the
 * sources search by meaning passes over, each named with why. Nothing while there is neither.
 */
function SearchByMeaning({ now }: { now: number }) {
  const switchRead = useEmbeddingSwitch();
  const passedRead = usePassedOver();
  const sw = switchRead.data;
  const passed = passedRead.data;
  const switching = sw !== undefined && sw !== null;
  const leftOut = passed !== undefined && passed.count > 0;
  if (!switching && !leftOut && !switchRead.error && !passedRead.error && !switchRead.isPending && !passedRead.isPending) return null;
  return (
    <div className="flex flex-col gap-s2" data-health-search-rebuild="">
      <h3 className="t-h3 text-ink">Search by meaning</h3>
      <ReadState data={sw} pending={switchRead.isPending} error={switchRead.error} onRetry={() => void switchRead.refetch()} label="search rebuilding">
        {(value) => value === null ? null : <Card><EmbeddingSwitchPanel sw={value} now={now} /></Card>}
      </ReadState>
      <ReadState data={passed} pending={passedRead.isPending} error={passedRead.error} onRetry={() => void passedRead.refetch()} label="sources left out of search">
        {(value) => value.count === 0 ? null : <Card data-health-passed-over="">
          <PassedOverSources list={value} lede={`Search by meaning leaves out ${formatCount(value.count, 'source')}. Search by words still finds ${value.count === 1 ? 'it' : 'them'}.`} />
        </Card>}
      </ReadState>
    </div>
  );
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
      <ReadState data={data} pending={status.isPending} error={status.error} onRetry={() => void status.refetch()} label="server status">
        {(value) => <StatusBody data={value} now={now} projectName={projectName} onRetry={() => void status.refetch()} />}
      </ReadState>
    </AdminSection>
  );
}

function StatusBody({ data, now, projectName, onRetry }: { data: StatusResponse; now: number; projectName: StatusSectionProps['projectName']; onRetry: () => void }) {
  const harnesses = data.harnesses ?? [];
  const schema = schemaLine(data.schema);
  const backlog = backlogWords(data.transcriptBacklog);
  const projects = [...data.projects].sort((a, b) => (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1));
  const measuredViews=data.views?.states.flatMap(row=>row.work?.state==='measured'?[row.work]:[])??[];
  return (
    <div className="flex flex-col gap-s4">
      <Card className="flex flex-col gap-s3" data-health-schema="">
        <p className="flex items-start gap-s2 t-body text-ink">
          <span className="flex h-lh shrink-0 items-center"><HealthDot tone={schema.tone} label={schema.tone === 'ok' ? 'Current' : 'Needs attention'} /></span>
          <span>{schema.words}</span>
        </p>
        {data.unavailable?.includes('schema') && <ReadUnavailable label="the database version" onRetry={onRetry} />}
        {data.unavailable?.includes('transcriptBacklog') && <ReadUnavailable label="transcripts waiting to be processed" onRetry={onRetry} />}
        {backlog !== null && <p className="t-small text-muted" data-testid="transcript-backlog">{backlog}</p>}
      </Card>

      {data.unavailable?.includes('views')?<ReadUnavailable label="session views" onRetry={onRetry}/>:data.views&&<Card className="flex flex-col gap-s2" data-testid="session-views">
        <h3 className="t-h3 text-ink">Session views</h3>
        <p className="t-small text-muted">{Object.entries(data.views.counts).filter(([,count])=>count>0).map(([state,count])=>count.toLocaleString()+' '+state.replaceAll('-',' ')).join(' · ')||'No captured sessions.'}</p>
        {data.views.states.filter(row=>row.bytes_behind>0||row.state==='failed'||row.state==='unrebuildable').slice(0,VIEW_STATUS_SESSION_LIMIT).map(row=><p key={row.project_id+'/'+row.session_id} className="t-small text-ink-2">
          {projectName(row.project_id)??'Project'} · {row.title??'Untitled session'}: {row.state.replaceAll('-',' ')}
          {row.bytes_behind>0&&' · '+formatBytes(row.bytes_behind)+' behind'}
          {row.last_failure&&' · '+row.last_failure}
          {row.last_refusal&&' · '+row.last_refusal}
          {row.work?.state==='measured'&&' · '+formatBytes(row.work.netBytesPerSecond)+'/s net measured'}
          {row.next_attempt_at!==null&&' · next attempt '+new Date(row.next_attempt_at).toLocaleString()}
        </p>)}
        {measuredViews.length>0&&<p className="t-small text-muted">Slowest sampled session: {formatBytes(Math.min(...measuredViews.map(row=>row.netBytesPerSecond)))}/s net across {formatCount(measuredViews.length,'sample')}.</p>}
        <p className="t-small text-muted">{data.views.throughput.state==='unavailable'?'Hosted rebuild projection is unavailable.':
          data.views.throughput.admit?'Measured rebuild capacity meets the convergence limit.':'The rebuild projection does not meet admission: '+data.views.throughput.binding_constraint.replaceAll('_',' ')+'.'}</p>
        {data.views.cleanup&&<p className="t-small text-muted">{formatCount(data.views.cleanup.retired,'retired view')} · {data.views.cleanup.eligibleRetired.toLocaleString()} beyond the hold · {formatCount(data.views.cleanup.abandoned,'abandoned build')}</p>}
        {data.views.findings&&<p className="t-small text-muted">{formatCount(data.views.findings.reduce((sum,row)=>sum+row.count,0),'finding')}</p>}
        {data.views.unplaced&&<p className="t-small text-muted">Unplaced records: unavailable. Coverage not carried: unavailable.</p>}
        {data.views.details&&!data.views.details.complete&&<p className="t-small text-muted">Showing details for {data.views.states.length.toLocaleString()} of {data.views.details.total.toLocaleString()} sessions.</p>}
      </Card>}
      <StoppedRecordings projectName={projectName} />
      {data.unavailable?.includes('installedAgents') ? <ReadUnavailable label="installed agents" onRetry={onRetry} /> : harnesses.length > 0 && <div className="flex flex-col gap-s2" data-health-harnesses="">
        <h3 className="t-h3 text-ink">Installed agents</h3>
        <RowCard label="Installed agents">
          {harnesses.map((fact) => <p key={`${fact.machineId}/${fact.id}`} className="px-s4 py-s2 t-body text-ink-2">{harnessHealthWords(fact)}</p>)}
        </RowCard>
      </div>}
      <QueueWarning queue={data.workers.available ? data.workers.queue : undefined} />
      <SearchByMeaning now={now} />

      <div className="flex flex-col gap-s2">
        <h3 className="t-h3 text-ink">What this server runs itself</h3>
        <p className="max-w-measure t-small text-muted">Machines running Myco’s work attach on their own and are listed on the Runners page.</p>
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
        {data.unavailable?.includes('projects') ? <ReadUnavailable label="what projects last sent" onRetry={onRetry} /> : projects.length === 0 ? (
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

function StoppedRecordings({ projectName }: Pick<StatusSectionProps, 'projectName'>) {
  const attention = useAttention({ enabled: true });
  const stopped = attention.data?.items.filter((item) => item.kind === 'transcripts_stopped') ?? [];
  if (attention.error) return <ReadUnavailable label="transcripts that couldn’t be read" onRetry={() => void attention.refetch()} />;
  if (attention.data?.unavailable.includes('transcripts_stopped')) return <ReadUnavailable label="transcripts that couldn’t be read" onRetry={() => void attention.refetch()} />;
  if (stopped.length === 0) return null;
  return <div className="flex flex-col gap-s2" data-health-transcripts="">
    <h3 className="t-h3 text-ink">Transcripts that couldn’t be read</h3>
    {stopped.map((item) => <Card key={item.projectId} className="flex flex-col gap-s2">
      <p className="t-body text-ink">{formatCount(item.transcripts, 'transcript')} in {projectName(item.projectId) ?? 'a project'}</p>
      <p className="t-small text-ink-2">Latest stop: {transcriptStopWords(item)}</p>
    </Card>)}
  </div>;
}
