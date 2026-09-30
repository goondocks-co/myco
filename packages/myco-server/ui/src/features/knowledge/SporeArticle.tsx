import { type ReactNode } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import { ChevronRight } from 'lucide-react';
import {
  Card, CopyButton, ErrorState, FactRow, FactsPanel, focusRing, Link, LoadingState, Markdown, StatusChip, TypeChip,
} from '../../design';
import { useMembers } from '../../hooks/use-access';
import { useSporeArticle, useSporeNeighbours } from '../../hooks/use-knowledge';
import { useSession } from '../../hooks/use-sessions';
import { useNow } from '../../hooks/use-today';
import { ApiError } from '../../lib/api';
import { cn } from '../../lib/cn';
import { sessionHeadingText } from '../../lib/session-text';
import { NotFound } from '../../pages/NotFound';
import { KNOWLEDGE_SUFFIX, projectPath } from '../../routes/nav';
import { dateTime } from '../sessions/words';
import type { SporeArticleAnswer } from './wire';
import {
  authorName, dayHeading, DEFAULT_SPORE_STATUS, shortDay, sporeAuthor, sporeHeadline, sporeStatusTone, sporeStatusWord, sporeTags, sporeTypeWord,
} from './words';

/** The top of the importance scale a writer assigns on. */
const MAX_IMPORTANCE = 10;

export interface SporeArticleProps {
  projectId: string;
  sporeId: string;
  /** The project's name, or null while the dashboard does not know it. */
  projectName: string | null;
}

/**
 * One spore as an article: its one line as the title, what it says in full at
 * a readable width, and beside it where it came from (the session, the turn,
 * and the run or member that wrote it) and its facts. A replaced spore says so
 * first and names what replaced it; a replacement names what it replaced at its foot.
 */
export function SporeArticle({ projectId, sporeId, projectName }: SporeArticleProps) {
  const article = useSporeArticle(projectId, sporeId);
  const now = useNow();
  if (article.error instanceof ApiError && article.error.status === 404) return <NotFound />;
  if (article.data === undefined) {
    if (article.isPending) return <LoadingState shape="reading" label="Loading the spore" />;
    return <ErrorState error={article.error} onRetry={() => void article.refetch()} />;
  }
  return <Article answer={article.data} projectId={projectId} projectName={projectName ?? 'A project'} now={now} />;
}

function Article({ answer, projectId, projectName, now }: { answer: SporeArticleAnswer; projectId: string; projectName: string; now: number }) {
  const { spore, supersededBy, supersedes } = answer;
  const headline = sporeHeadline(spore, now);
  const tags = sporeTags(spore.tags);
  const context = spore.context?.trim() ?? '';
  const current = spore.status === DEFAULT_SPORE_STATUS;
  return (
    <article data-spore-article="" className="flex w-full flex-col gap-s5">
      <nav aria-label="Breadcrumb">
        <ol className="flex flex-wrap items-center gap-s1 t-small text-muted">
          <li><Crumb to={KNOWLEDGE_SUFFIX}>Knowledge</Crumb></li>
          <li aria-hidden><ChevronRight className="size-s4" /></li>
          <li><Crumb to={projectPath(projectId, KNOWLEDGE_SUFFIX)}>{projectName}</Crumb></li>
        </ol>
      </nav>

      <div className="grid items-start gap-s6 lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-x-s10">
        <div className="flex min-w-0 max-w-measure flex-col gap-s5">
          {supersededBy.length > 0 && <Replaced projectId={projectId} ids={supersededBy} now={now} />}
          <header className="flex flex-col gap-s3">
            <p className="flex flex-wrap items-center gap-x-s2 gap-y-s1 t-small text-muted">
              <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
              {!current && <StatusChip tone={sporeStatusTone(spore.status)} data-spore-status="">{sporeStatusWord(spore.status)}</StatusChip>}
              <span>Saved <time dateTime={new Date(spore.createdAt).toISOString()}>{dayHeading(spore.createdAt, now)}</time></span>
            </p>
            <h1 className={cn('t-headline', headline.lined ? 'text-ink' : 'text-ink-2')} data-spore-title="">{headline.text}</h1>
          </header>
          <section aria-label="What it says" data-spore-body="">
            <Markdown content={spore.content} />
          </section>
          {context !== '' && (
            <section aria-labelledby="spore-context" className="flex flex-col gap-s2 border-l-2 border-line-strong pl-s4" data-spore-context="">
              <h2 id="spore-context" className="t-h3 text-ink">Context</h2>
              <Markdown content={context} />
            </section>
          )}
          {tags.length > 0 && (
            <ul aria-label="Tags" className="flex flex-wrap gap-s2">
              {tags.map((tag) => <li key={tag}><TypeChip>{tag}</TypeChip></li>)}
            </ul>
          )}
          {supersedes.length > 0 && (
            <section aria-labelledby="spore-lineage" className="flex flex-col gap-s3 border-t border-line pt-s5" data-spore-lineage="">
              <h2 id="spore-lineage" className="t-h3 text-ink">What it replaced</h2>
              <Neighbours projectId={projectId} ids={supersedes} label="What it replaced" now={now} />
            </section>
          )}
        </div>

        <aside aria-label="About this spore" className="flex min-w-0 flex-col gap-s4">
          <Origin answer={answer} projectId={projectId} now={now} />
          <FactsPanel title="Facts" actions={<CopyButton value={spore.id} label="Copy spore id" variant="secondary" />}>
            <FactRow term="Project">{projectName}</FactRow>
            <FactRow term="Type">{sporeTypeWord(spore.observationType)}</FactRow>
            <FactRow term="Status">{sporeStatusWord(spore.status)}</FactRow>
            <FactRow term="Importance">{spore.importance} of {MAX_IMPORTANCE}</FactRow>
            <FactRow term="Saved">{dateTime(spore.createdAt, now)}</FactRow>
            {spore.updatedAt !== null && spore.updatedAt !== spore.createdAt && <FactRow term="Changed">{dateTime(spore.updatedAt, now)}</FactRow>}
            {spore.filePath !== null && spore.filePath.trim() !== '' && <FactRow term="File" mono>{spore.filePath}</FactRow>}
          </FactsPanel>
        </aside>
      </div>
    </article>
  );
}

function Crumb({ to, children }: { to: string; children: ReactNode }) {
  return <RouterLink to={to} className={cn('rounded-chip hover:text-ink hover:underline', focusRing)}>{children}</RouterLink>;
}

/** A replaced spore says so before anything else, and leads to what replaced it. */
function Replaced({ projectId, ids, now }: { projectId: string; ids: readonly string[]; now: number }) {
  return (
    <div role="note" className="flex flex-col gap-s2 rounded-card border border-line bg-warn-bg px-s4 py-s3" data-spore-replaced="">
      <p className="t-small font-medium text-warn">This spore was replaced. Read what replaced it:</p>
      <Neighbours projectId={projectId} ids={ids} label="What replaced it" now={now} />
    </div>
  );
}

/** The spores on the other side of a replacement, each by its line and linked to its own article. */
function Neighbours({ projectId, ids, label, now }: { projectId: string; ids: readonly string[]; label: string; now: number }) {
  const neighbours = useSporeNeighbours(projectId, ids);
  return (
    <div className="flex flex-col gap-s2">
      <ul aria-label={label} className="flex flex-col gap-s2">
        {ids.map((id, i) => {
          const read = neighbours[i];
          const spore = read?.data?.spore;
          return (
            <li key={id} className="flex min-w-0 items-baseline gap-s2 t-small">
              {spore === undefined ? (
                read?.isPending
                  ? <span className="text-muted">Loading…</span>
                  : <span className="text-muted">A spore this project no longer holds</span>
              ) : (
                <>
                  <TypeChip>{sporeTypeWord(spore.observationType)}</TypeChip>
                  <Link to={projectPath(projectId, `/spores/${encodeURIComponent(id)}`)} className="line-clamp-2 min-w-0">
                    {sporeHeadline(spore, now).text}
                  </Link>
                  <span className="shrink-0 t-meta text-muted">{shortDay(spore.createdAt, now)}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** Where the spore came from: the session it was learned from, the turn, and what wrote it. */
function Origin({ answer, projectId, now }: { answer: SporeArticleAnswer; projectId: string; now: number }) {
  const { spore } = answer;
  const author = sporeAuthor(spore.author);
  const members = useMembers();
  return (
    <Card className="flex flex-col gap-s3" data-spore-origin="">
      <h2 className="t-h3 text-ink">Where it came from</h2>
      {spore.sessionId === null
        ? <p className="t-small text-muted">Saved outside a session.</p>
        : <FromSession projectId={projectId} sessionId={spore.sessionId} promptId={spore.promptId} />}
      {author.kind === 'run' && (
        <p className="flex flex-col gap-s1 t-small text-ink-2" data-spore-author="run">
          Myco wrote it while learning from your sessions.
          <Link to={projectPath(projectId, `/runs/${encodeURIComponent(author.runId)}`)} className="w-fit">The run that wrote it →</Link>
        </p>
      )}
      {author.kind === 'member' && (
        <p className="t-small text-ink-2" data-spore-author="member">
          {(() => {
            const name = authorName(author.memberId, members.data?.members);
            return name === null ? 'Saved by a member.' : `Saved by ${name}.`;
          })()}
        </p>
      )}
      {author.kind === 'key' && <p className="t-small text-ink-2" data-spore-author="key">Saved with an access key.</p>}
      {spore.sourceCreatedAt !== null && <p className="t-meta text-muted">From a turn on {dateTime(spore.sourceCreatedAt, now)}.</p>}
    </Card>
  );
}

function FromSession({ projectId, sessionId, promptId }: { projectId: string; sessionId: string; promptId: string | null }) {
  const session = useSession(projectId, sessionId);
  const base = projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`);
  const turn = promptId === null ? null : `${base}?${new URLSearchParams({ turn: promptId })}`;
  if (session.error instanceof ApiError && session.error.status === 404) {
    return <p className="t-small text-muted">Learned from a session this project no longer holds.</p>;
  }
  return (
    <div className="flex flex-col gap-s1" data-spore-session="">
      <span className="t-meta text-muted">Learned from</span>
      {session.data === undefined
        ? <span className="t-small text-muted">{session.isPending ? 'Loading the session…' : 'A session'}</span>
        : <span className="t-small font-medium text-ink">{sessionHeadingText(session.data.session)}</span>}
      <span className="flex flex-wrap gap-x-s4 gap-y-s1 t-small">
        <Link to={base}>Open the session →</Link>
        {turn !== null && <Link to={turn}>The turn it came from →</Link>}
      </span>
    </div>
  );
}
