import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RawClaimOutcome, RawClaimPreview } from '@goondocks/myco-shared/raw-claims';
import { Button, Card, ConfirmDialog, DataTable, EmptyState, ErrorState, Input, LoadingState, type DataTableColumn } from '../../../design';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { formatDateTime } from '../../../lib/format';
import { projectPath } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';

const CLAIM_LABEL = 'Claim raw data with no recorded uploader';
const CLAIM_KEY = ['raw-claims'] as const;
const RAW_READS = ['sessions', 'session', 'turn', 'transcript', 'blobs'] as const;
const KIND_NAMES = { blob: 'Raw blobs', event: 'Capture events', transcript: 'Transcripts' } as const;
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
    if (error.code === 'revision_conflict') return 'The raw data changed. Review the refreshed preview before claiming it.';
    if (error.code === 'backfill_pending') return 'Uploader checks are still running. Wait for them to finish, then review the preview again.';
    if (error.code === 'not_owner') return 'Only the recorded owner of this server can claim this data.';
    return `The server refused the claim (${error.status}).`;
  }
  return 'Could not reach the server. Refresh the preview before trying again.';
}

function Preview({ preview, compact = false }: { preview: RawClaimPreview; compact?: boolean }) {
  const rows = previewRows(preview);
  if (compact) return (
    <ul aria-label="Raw data claim preview" className="flex flex-col gap-s2">
      {rows.map((row) => <li key={`${row.projectId}:${row.kind}`}>
        <Card className="flex flex-col gap-s1">
          <p className="t-body font-medium text-ink">{row.projectName}</p>
          <p className="t-small text-muted">{previewMetadata(row)}</p>
        </Card>
      </li>)}
    </ul>
  );
  return (
    <DataTable label="Raw data with no recorded uploader" columns={PREVIEW_COLUMNS}
      groups={[{ key: 'preview', label: 'Raw data to claim', rows }]}
      rowKey={(row) => `${row.projectId}:${row.kind}`} rowHref={(row) => projectPath(row.projectId, '/sessions')}
      phoneMeta={previewMetadata} />
  );
}

/** The recorded owner reviews one revision before claiming raw data whose uploader is absent. */
export function RawClaims() {
  const client = useQueryClient();
  const preview = useQuery({ queryKey: CLAIM_KEY, queryFn: ({ signal }) => fetchJson<RawClaimPreview>('/api/raw-claims', signal) });
  const [review, setReview] = useState<RawClaimPreview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const claim = useMutation({
    mutationFn: (revision: string) => postJson<RawClaimOutcome>('/api/raw-claims', { revision }),
    onSuccess: async (outcome) => {
      setReview(null);
      setConfirmed(false);
      setNotice(outcome.claimId === null ? 'There is no raw data to claim.' : 'The reviewed raw data is now private to you.');
      client.setQueryData(CLAIM_KEY, outcome.preview);
      await Promise.all([CLAIM_KEY[0], ...RAW_READS].map((key) => client.invalidateQueries({ queryKey: [key] })));
    },
    onError: async () => {
      setReview(null);
      setConfirmed(false);
      await client.invalidateQueries({ queryKey: CLAIM_KEY });
    },
  });
  const total = preview.data?.projects.reduce((sum, project) => sum + project.kinds.reduce((n, kind) => n + kind.count, 0), 0) ?? 0;
  return (
    <AdminSection id="raw-claims" title="Raw data with no recorded uploader" description="As this server’s owner, you can claim raw data with no recorded uploader. Claimed data becomes private to you.">
      {preview.isPending ? <LoadingState label="Checking raw data uploaders" />
        : preview.isError ? <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        : <Card className="flex flex-col gap-s4">
          {total > 0 ? <Preview preview={preview.data} /> : <EmptyState title="No raw data with no recorded uploader." />}
          {!preview.data.complete && <p role="status" className="t-small text-muted">Uploader checks are still running. Claiming is available when they finish.</p>}
          <Button disabled={!preview.data.complete || total === 0 || claim.isPending} onClick={() => { claim.reset(); setNotice(null); setConfirmed(false); setReview(preview.data); }}>{CLAIM_LABEL}</Button>
        </Card>}
      {claim.isError && <p role="alert" className="t-small text-bad">{claimError(claim.error)}</p>}
      {notice !== null && <p role="status" className="t-small text-ink">{notice}</p>}
      <ConfirmDialog open={review !== null} onOpenChange={(open) => { if (!open) { setReview(null); setConfirmed(false); } }} title={CLAIM_LABEL}
        description="The raw data in this preview will become private to you. This records you as its owner."
        confirmLabel={CLAIM_LABEL} tone="primary" pending={claim.isPending} confirmDisabled={!confirmed || review?.complete !== true}
        onConfirm={() => { if (confirmed && review?.complete === true && !claim.isPending) claim.mutate(review.revision); }}>
        {review !== null && <Preview preview={review} compact />}
        <label className="flex items-start gap-s2 t-small"><Input type="checkbox" className="size-s4 shrink-0 px-0" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed these projects, kinds, counts and dates and want to claim this raw data.</label>
      </ConfirmDialog>
    </AdminSection>
  );
}
