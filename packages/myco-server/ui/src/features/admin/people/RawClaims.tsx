import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RawClaimOutcome, RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Input, LoadingState, type DataTableColumn } from '../../../design';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { projectPath } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import { live } from '../../../lib/live';

const CLAIM_LABEL = 'Take ownership of raw data with no known uploader';
const CLAIM_KEY = ['raw-claims'] as const;
const RAW_READS = ['sessions', 'session', 'turn', 'transcript', 'blobs'] as const;
const KIND_NAMES = { blob: 'Stored files', event: 'Captured events', transcript: 'Transcripts' } as const;
type PreviewRow = RawClaimPreview['projects'][number]['kinds'][number] & { projectId: string; projectName: string };
const previewDate = (at: number | null) => at === null ? 'Unknown' : formatDateTime(at);
const PREVIEW_COLUMNS: readonly DataTableColumn<PreviewRow>[] = [
  { key: 'project', header: 'Project', cell: (row) => row.projectName },
  { key: 'kind', header: 'Kind', cell: (row) => KIND_NAMES[row.kind], width: 'md' },
  { key: 'count', header: 'Count', cell: (row) => row.count.toLocaleString(), align: 'end', width: 'sm' },
  { key: 'oldest', header: 'Oldest', cell: (row) => previewDate(row.oldestAt), width: 'md' },
  { key: 'newest', header: 'Newest', cell: (row) => previewDate(row.newestAt), width: 'md' },
];
const previewRows = (preview: RawClaimPreview): PreviewRow[] => preview.projects.flatMap((project) => project.kinds.map((kind) => ({ ...kind, projectId: project.projectId, projectName: project.name })));
const previewMetadata = (row: PreviewRow) => `${KIND_NAMES[row.kind]} · Count: ${row.count.toLocaleString()} · Oldest: ${previewDate(row.oldestAt)} · Newest: ${previewDate(row.newestAt)}`;

function claimError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'revision_conflict') return 'Nothing changed: the raw data changed while this was open. Close this and review the refreshed list.';
    if (error.code === 'backfill_pending') return 'Nothing changed: Myco is still working out who uploaded what. Wait for it to finish, then review the list again.';
    if (error.code === 'not_owner') return 'Nothing changed: only this server’s recorded owner can take ownership of this data.';
    return `Nothing changed: the server refused (${error.status}).`;
  }
  return 'Nothing changed: the server could not be reached. Close this and try again.';
}

function Preview({ preview, compact = false }: { preview: RawClaimPreview; compact?: boolean }) {
  const rows = previewRows(preview);
  if (compact) return (
    <ul aria-label="Raw data to take ownership of" className="flex flex-col gap-s2">
      {rows.map((row) => <li key={`${row.projectId}:${row.kind}`}>
        <Card className="flex flex-col gap-s1">
          <p className="t-body font-medium text-ink">{row.projectName}</p>
          <p className="t-small text-muted">{previewMetadata(row)}</p>
        </Card>
      </li>)}
    </ul>
  );
  return (
    <DataTable label="Raw data with no known uploader" columns={PREVIEW_COLUMNS}
      groups={[{ key: 'preview', label: 'Raw data to take ownership of', rows }]}
      rowKey={(row) => `${row.projectId}:${row.kind}`} rowHref={(row) => projectPath(row.projectId, '/sessions')}
      phoneMeta={previewMetadata} />
  );
}

/** The recorded owner reviews one revision before claiming raw data whose uploader is absent. */
export function RawClaims({ nested = false }: { nested?: boolean }) {
  const client = useQueryClient();
  const preview = useQuery({ queryKey: CLAIM_KEY, queryFn: ({ signal }) => fetchJson<RawClaimPreview>('/api/raw-claims', signal), ...live('still') });
  const [review, setReview] = useState<RawClaimPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const claim = useMutation({
    mutationFn: (revision: string) => postJson<RawClaimOutcome>('/api/raw-claims', { revision }),
    onSuccess: async (outcome) => {
      setReview(null);
      setConfirmed(false);
      setNotice(outcome.claimId === null ? 'There is no raw data to take ownership of.' : 'That raw data is now yours, and private to you.');
      client.setQueryData(CLAIM_KEY, outcome.preview);
      await Promise.all([CLAIM_KEY[0], ...RAW_READS].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: async () => {
      setConfirmed(false);
      await client.invalidateQueries({ queryKey: CLAIM_KEY });
    },
  });
  const total = preview.data?.projects.reduce((sum, project) => sum + project.kinds.reduce((n, kind) => n + kind.count, 0), 0) ?? 0;
  return (
    <AdminSection id="raw-claims" nested={nested} title="Raw data with no known uploader" description="Raw data is what machines sent before Myco processed it: transcripts, stored files and captured events. Each piece is private to whoever uploaded it. Some has no known uploader; as this server’s owner, you can take ownership of it, and it becomes private to you.">
      {preview.isPending ? <LoadingState label="Checking raw data uploaders" />
        : preview.isError ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        : <Card className="flex flex-col gap-s4">
          {total > 0 ? <Preview preview={preview.data} /> : <EmptyState title="All raw data has a known uploader." />}
          {!preview.data.complete && <p role="status" className="t-small text-muted">Myco is still working out who uploaded what. You can take ownership once it finishes.</p>}
          <Button disabled={!preview.data.complete || total === 0 || claim.isPending} onClick={() => { claim.reset(); setNotice(null); setConfirmed(false); setReview(preview.data); }}>{CLAIM_LABEL}</Button>
        </Card>}
      {notice !== null && <p role="status" className="t-small text-ink">{notice}</p>}
      <ConfirmDialog open={review !== null} onOpenChange={(open) => { if (!open) { setReview(null); setConfirmed(false); claim.reset(); } }} title="Take ownership of this raw data?"
        description="You are recorded as its uploader, and only you can read it from then on. The files and event contents stay as they are."
        confirmLabel="Take ownership" tone="primary" pending={claim.isPending} confirmDisabled={!confirmed || review?.complete !== true || claim.isError}
        error={claim.isError ? claimError(claim.error) : null}
        onConfirm={() => { if (confirmed && review?.complete === true && !claim.isPending) claim.mutate(review.revision); }}>
        {review !== null && <Preview preview={review} compact />}
        <label className="flex items-start gap-s2 t-small"><Input type="checkbox" className="size-s4 shrink-0 px-0" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed these projects, kinds, counts and dates, and want to take ownership of this raw data.</label>
      </ConfirmDialog>
    </AdminSection>
  );
}
