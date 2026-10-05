import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeploymentOwnershipPreview } from '@goondocks/myco-shared/raw-claims';
import { Button, Card, ConfirmDialog, ErrorState, LoadingState, Select } from '../../../design';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { ME_KEY } from '../../../lib/query-client';
import { AdminSection } from '../AdminFrame';

const OWNERSHIP_KEY = ['ownership'] as const;

/** An admin explicitly chooses the initial owner from the live, linked human admins. */
export function Ownership({ candidates }: { candidates: Array<{ id: string; name: string }> }) {
  const client = useQueryClient();
  const ownership = useQuery({ queryKey: OWNERSHIP_KEY, queryFn: ({ signal }) => fetchJson<DeploymentOwnershipPreview>('/api/ownership', signal) });
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<{ revision: string; ownerMemberId: string; name: string } | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const record = useMutation({
    mutationFn: (body: { revision: string; ownerMemberId: string }) => postJson<DeploymentOwnershipPreview>('/api/ownership', body),
    onSuccess: async (outcome) => {
      setReview(null);
      client.setQueryData(OWNERSHIP_KEY, outcome);
      await Promise.all([client.invalidateQueries({ queryKey: OWNERSHIP_KEY }), client.invalidateQueries({ queryKey: ME_KEY })]);
    },
    onError: async () => { setReview(null); setConfirmed(false); await client.invalidateQueries({ queryKey: OWNERSHIP_KEY }); },
  });
  if (ownership.data?.ownerMemberId != null && !record.isError) return null;
  const candidate = candidates.find((person) => person.id === selected);
  return (
    <AdminSection id="ownership" title="Server owner" description="Choose who owns this server. Only its recorded owner can claim raw data with no recorded uploader.">
      {ownership.isPending ? <LoadingState label="Reading server ownership" />
        : ownership.isError ? <ErrorState error={ownership.error} onRetry={() => void ownership.refetch()} />
        : ownership.data.ownerMemberId !== null ? <Card><p className="t-small text-muted">An owner is already recorded. This choice cannot replace them.</p></Card>
        : <Card className="flex flex-col gap-s4">
          <p className="t-small text-muted">No owner is recorded. Choose an admin with a connected GitHub account. This choice can be made once.</p>
          <Select label="Server owner" value={selected} onValueChange={setSelected} placeholder="Choose an owner" options={candidates.map((person) => ({ value: person.id, label: person.name }))} />
          <Button disabled={candidate === undefined || record.isPending} onClick={() => { if (candidate !== undefined) { record.reset(); setConfirmed(false); setReview({ revision: ownership.data.revision, ownerMemberId: candidate.id, name: candidate.name }); } }}>Record server owner</Button>
        </Card>}
      {record.isError && <p role="alert" className="t-small text-bad">{record.error instanceof ApiError && record.error.code === 'revision_conflict' ? 'Ownership changed. Review it again before recording an owner.' : 'The server could not record this owner. Refresh ownership before trying again.'}</p>}
      <ConfirmDialog open={review !== null} onOpenChange={(open) => { if (!open) { setReview(null); setConfirmed(false); } }} title="Record server owner"
        description={`Record ${review?.name ?? ''} as this server’s owner. This choice can be made once.`} confirmLabel="Record server owner" tone="primary" pending={record.isPending} confirmDisabled={!confirmed}
        onConfirm={() => { if (review !== null && confirmed && !record.isPending) record.mutate({ revision: review.revision, ownerMemberId: review.ownerMemberId }); }}>
        <label className="flex items-start gap-s2 t-small"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the selected person and want to record them as the server owner.</label>
      </ConfirmDialog>
    </AdminSection>
  );
}
