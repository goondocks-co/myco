import { useNavigate, useParams } from 'react-router-dom';
import { Badge } from '../components/ui/badge';
import { MarkdownContent } from '../components/ui/markdown-content';
import { MasterDetailSplit } from '../components/ui/master-detail-split';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { Row } from '../components/ui/row';
import { useSkill, useSkillReleaseStates, useSkills, type ReleaseStateRow, type SkillRecord } from '../hooks/use-intelligence';
import { ApiError } from '../lib/api';
import { formatCount, formatDateTime, formatRelative } from '../lib/format';
import { NotFound } from './NotFound';

const sourceCount = (raw: string): number => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
};

/** `/p/:projectId/skills` and `/p/:projectId/skills/:skillId`: the procedures this project's memory produced. */
export function Skills() {
  const { projectId = '', skillId } = useParams();
  const navigate = useNavigate();
  const skills = useSkills(projectId);
  const base = `/p/${encodeURIComponent(projectId)}/skills`;
  const list = skills.data?.skills ?? [];

  return (
    <PageContainer>
      <PageHeader title="Skills" subtitle="Procedures generated from this project's memory, with what each one is built on." />
      <PageLoading isLoading={skills.isPending} error={skills.error}>
        <div className="min-h-[60vh] rounded-lg border border-outline-variant/20">
          <MasterDetailSplit
            hasSelection={skillId !== undefined}
            onCloseMobileDetail={() => navigate(base)}
            masterAriaLabel="Skills"
            detailAriaLabel="Skill"
            master={
              list.length === 0 ? (
                <p className="p-4 font-sans text-sm text-on-surface-variant">No skills yet. Skills appear here once the skill tasks have run.</p>
              ) : (
                <div role="table" aria-label="Skills">
                  {list.map((skill) => (
                    <Row key={skill.id} isActive={skill.id === skillId} onClick={() => navigate(`${base}/${encodeURIComponent(skill.id)}`)}>
                      <div className="flex items-center gap-2 font-sans text-sm">
                        <span className="min-w-0 flex-1 truncate text-on-surface">{skill.displayName}</span>
                        {skill.status !== 'active' && <Badge variant="outline">{skill.status}</Badge>}
                      </div>
                      <div className="mt-0.5 truncate font-sans text-xs text-on-surface-variant">{skill.description}</div>
                      <div className="mt-1 flex gap-3 font-mono text-[11px] text-on-surface-variant">
                        <span>gen {skill.generation}</span>
                        <span>{formatCount(skill.usageCount, 'use')}</span>
                      </div>
                    </Row>
                  ))}
                </div>
              )
            }
            detail={
              skillId === undefined
                ? <p className="font-sans text-sm text-on-surface-variant">Select a skill to read it.</p>
                : <SkillDetail projectId={projectId} skillId={skillId} record={list.find((s) => s.id === skillId) ?? null} />
            }
          />
        </div>
      </PageLoading>
    </PageContainer>
  );
}

function SkillDetail({ projectId, skillId, record }: { projectId: string; skillId: string; record: SkillRecord | null }) {
  const skill = useSkill(projectId, skillId);
  const releases = useSkillReleaseStates(projectId);
  if (skill.error instanceof ApiError && skill.error.status === 404) return <NotFound />;
  const release = releases.data?.releaseStates.find((r) => r.recordId === skillId) ?? null;
  return (
    <PageLoading isLoading={skill.isPending} error={skill.error}>
      {skill.data && (
        <div className="flex flex-col gap-4">
          <div>
            <div className="font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Skill · {record?.name ?? skillId}</div>
            <h2 className="font-serif text-xl text-on-surface">{record?.displayName ?? skillId}</h2>
            {record && <p className="font-sans text-sm text-on-surface-variant">{record.description}</p>}
          </div>

          <div className="flex flex-wrap gap-2">
            {record && <Badge variant="secondary">generation {record.generation}</Badge>}
            {record && <Badge variant="secondary">{formatCount(record.usageCount, 'use')}{record.lastUsedAt === null ? '' : `, last ${formatRelative(record.lastUsedAt)}`}</Badge>}
            {record && <Badge variant="secondary">{formatCount(sourceCount(record.sourceIds), 'source')}</Badge>}
            {record && record.status !== 'active' && <Badge variant="outline">{record.status}</Badge>}
            {release && <ReleaseBadge release={release} />}
          </div>

          <Panel title="Published content">
            {skill.data.content === null
              ? <p className="font-sans text-sm text-on-surface-variant">No published content.</p>
              : <MarkdownContent content={skill.data.content} />}
          </Panel>

          <Panel title="Lineage">
            {skill.data.lineage.length === 0 ? (
              <p className="font-sans text-sm text-on-surface-variant">No lineage recorded.</p>
            ) : (
              <ol className="flex flex-col gap-2" aria-label="Lineage">
                {skill.data.lineage.map((entry) => (
                  <li key={entry.id} className="font-sans text-sm">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-[11px] text-on-surface-variant">gen {entry.generation}</span>
                      <span className="text-on-surface">{entry.action}</span>
                      <span className="ml-auto text-xs text-on-surface-variant" title={formatDateTime(entry.createdAt)}>{formatRelative(entry.createdAt)}</span>
                    </div>
                    <p className="mt-0.5 text-xs text-on-surface-variant">{entry.rationale}</p>
                  </li>
                ))}
              </ol>
            )}
          </Panel>
        </div>
      )}
    </PageLoading>
  );
}

/** Where this skill stands against the code it describes, as the last release check found it. */
function ReleaseBadge({ release }: { release: ReleaseStateRow }) {
  const variant = release.state === 'released' ? 'default' : release.state === 'stale' || release.state === 'drifted' ? 'warning' : 'secondary';
  return (
    <Badge variant={variant} title={release.reason ?? undefined} data-testid="release-state">
      {release.state}{release.basisRef ? ` · ${release.basisRef}` : ''} · {release.confidence}
    </Badge>
  );
}
