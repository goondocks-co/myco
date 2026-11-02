import { Link as RouterLink, useSearchParams } from 'react-router-dom';
import { EmptyState, ErrorState, FilterPills, Link, LoadingState, ShowMore, StatusChip, focusRing } from '../../design';
import { useSessionFiles, type FileKind, type SessionFile } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';

/** The URL key of the tab's one filter; switching tabs drops it. */
export const FILE_KIND_KEY = 'kind';

const KINDS: ReadonlyArray<{ value: FileKind; label: string }> = [
  { value: 'edited', label: 'Edited' },
  { value: 'read', label: 'Only read' },
  { value: 'all', label: 'All' },
];

const EMPTY: Readonly<Record<FileKind, string>> = {
  edited: 'No tool edited a file in this session.',
  read: 'No file was only read in this session.',
  all: 'No tool named a file in this session.',
};

const columns = 'sm:grid sm:grid-file-row sm:items-center sm:gap-s3';

function FileRow({ file }: { file: SessionFile }) {
  const body = (
    <>
      <code className="min-w-0 t-mono break-all text-ink-2">{file.path}</code>
      <span className="flex items-center gap-s2 sm:contents">
        <StatusChip className="w-fit">{file.edits > 0 ? 'Edited' : 'Read'}</StatusChip>
        <span className="t-small tabular-nums text-muted sm:text-right"><span className="sm:hidden">Calls </span>{file.calls.toLocaleString()}</span>
        <span className="t-small text-muted">{file.lastTurn === null ? 'Not placed' : 'Open turn'}</span>
      </span>
    </>
  );
  const row = cn('flex w-full flex-col gap-s1 border-b border-line px-s3 py-s2 last:border-b-0', columns);
  if (file.lastTurn === null) return <li className={row}>{body}</li>;
  return (
    <li className="border-b border-line last:border-b-0">
      <RouterLink to={`?${new URLSearchParams({ turn: file.lastTurn })}`} className={cn(row, 'border-b-0 hover:bg-surface-2', focusRing, 'focus-visible:-outline-offset-2')}>{body}</RouterLink>
    </li>
  );
}

/** The files the session's tools named, edited first by default; each row opens the last turn that named the file. */
export function SessionFiles({ projectId, sessionId }: { projectId: string; sessionId: string }) {
  const [params, setParams] = useSearchParams();
  const kind = KINDS.find((one) => one.value === params.get(FILE_KIND_KEY))?.value ?? 'edited';
  const files = useSessionFiles(projectId, sessionId, kind);
  const pick = (next: FileKind) => {
    const copy = new URLSearchParams(params);
    if (next === 'edited') copy.delete(FILE_KIND_KEY); else copy.set(FILE_KIND_KEY, next);
    setParams(copy, { replace: true });
  };
  return (
    <div className="flex max-w-reference flex-col gap-s3" data-session-files="">
      <FilterPills label="Show" options={KINDS} value={kind} onChange={pick} />
      <p className="max-w-measure t-small text-muted">
        Files the agent’s tools named. A change made through a shell command does not appear here; the commits are on <Link to={`?${new URLSearchParams({ tab: 'outcomes' })}`} className="tap-inline">Outcomes</Link>.
      </p>
      {files.isPending ? <LoadingState label="Loading the files" count={3} />
        : files.error && files.rows.length === 0 ? <ErrorState error={files.error} onRetry={files.retry} />
        : files.rows.length === 0 ? <EmptyState title={EMPTY[kind]} />
        : (
          <div>
            {files.error && <ErrorState error={files.error} onRetry={files.retry} />}
            <div className="overflow-hidden rounded-card border border-line bg-surface-1">
              <div aria-hidden className={cn('hidden border-b border-line bg-surface-2 px-s3 py-s2 t-meta font-medium text-muted', columns)}>
                <span>File</span><span>Kind</span><span className="text-right">Calls</span><span>Last turn</span>
              </div>
              <ul aria-label="Files">{files.rows.map((file) => <FileRow key={file.path} file={file} />)}</ul>
            </div>
            <ShowMore shown={files.rows.length} noun="files" onMore={files.more} pending={files.isFetchingMore} hasMore={files.hasMore} />
            {files.capped && <p className="t-small text-muted">Myco keeps the first 500 files a session names, so this session’s later files are not listed.</p>}
          </div>
        )}
    </div>
  );
}
