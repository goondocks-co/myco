import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeploymentOwnershipPreview } from '@goondocks/myco-shared/raw-claims';
import { Button, Card, ConfirmDialog, ErrorState, Input, LoadingState, Select } from '../../../design';
import { ApiError, fetchJson, postJson } from '../../../lib/api';
import { ME_KEY } from '../../../lib/query-client';
import { AdminSection } from '../AdminFrame';

const OWNERSHIP_KEY = ['ownership'] as const;
type Review = { kind: 'record' | 'transfer'; revision: string; memberId: string; name: string };
type Candidate = DeploymentOwnershipPreview['candidates'][number];

/** The server's preview supplies eligible admins and the revision for an explicit owner change. */
export function Ownership({ isOwner, nameOfCandidate }: { isOwner: boolean; nameOfCandidate: (candidate: Candidate) => string }) {
  const client = useQueryClient();
  const ownership = useQuery({ queryKey: OWNERSHIP_KEY, queryFn: ({ signal }) => fetchJson<DeploymentOwnershipPreview>('/api/ownership', signal) });
  const [selected, setSelected] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (choice: Review) => choice.kind === 'record'
      ? postJson<DeploymentOwnershipPreview>('/api/ownership', { ownerMemberId: choice.memberId, revision: choice.revision })
      : postJson<DeploymentOwnershipPreview>('/api/ownership/transfer', { member_id: choice.memberId, expected_revision: choice.revision }),
    onSuccess: async (outcome) => {
      setReview(null);
      setConfirmed(false);
      setSelected('');
      setError(null);
      client.setQueryData(OWNERSHIP_KEY, outcome);
      await Promise.all([client.invalidateQueries({ queryKey: OWNERSHIP_KEY }), client.invalidateQueries({ queryKey: ME_KEY })]);
    },
    onError: async (failure) => {
      setReview(null);
      setConfirmed(false);
      setError(failure instanceof ApiError && failure.code === 'revision_conflict'
        ? 'Ownership changed. Review the refreshed owner and choose again.'
        : 'The server could not change the owner. Review the refreshed ownership before trying again.');
      await client.invalidateQueries({ queryKey: OWNERSHIP_KEY });
    },
  });
  const preview = ownership.data;
  const canChange = preview?.ownerMemberId === null || isOwner;
  const candidates = preview?.candidates.filter((person) => person.memberId !== preview.ownerMemberId) ?? [];
  const proposal = candidates.find((person) => person.memberId === preview?.proposalMemberId);
  const candidate = candidates.find((person) => person.memberId === selected);
  const label = preview?.ownerMemberId === null ? 'Record server owner' : 'Transfer server ownership';
  const choose = () => {
    if (preview === undefined || candidate === undefined) return;
    setError(null);
    change.reset();
    setConfirmed(false);
    setReview({ kind: preview.ownerMemberId === null ? 'record' : 'transfer', revision: preview.revision, memberId: candidate.memberId, name: nameOfCandidate(candidate) });
  };
  return (
    <AdminSection id="ownership" title="Server owner" description="The owner controls roles and ownership of this server, and may claim raw data with no recorded uploader.">
      {ownership.isPending ? <LoadingState label="Reading server ownership" />
        : ownership.isError ? <ErrorState error={ownership.error} onRetry={() => void ownership.refetch()} />
        : preview === undefined ? null
        : <Card className="flex flex-col gap-s4">
          {preview.ownerMemberId === null
            ? <p className="t-small text-muted">No owner is recorded. Choose an admin with a connected GitHub account.</p>
            : <p className="t-small text-muted">A server owner is recorded. {isOwner ? 'You can transfer ownership to another connected admin. You remain an admin after transfer.' : 'Only the recorded owner can transfer ownership.'}</p>}
          {proposal !== undefined && <p className="t-small text-muted">Proposed server owner: {nameOfCandidate(proposal)}. Review and confirm this choice; ownership has not changed.</p>}
          {canChange && <>
            {candidates.length === 0 && <p className="t-small text-muted">There is no eligible admin to choose. Promote or connect another person first.</p>}
            <Select label={preview.ownerMemberId === null ? 'Server owner' : 'New server owner'} value={selected} onValueChange={setSelected} placeholder="Choose an admin" options={candidates.map((person) => ({ value: person.memberId, label: nameOfCandidate(person) }))} />
            <Button disabled={candidate === undefined || change.isPending} onClick={choose}>{label}</Button>
          </>}
        </Card>}
      {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
      <ConfirmDialog open={review !== null} onOpenChange={(open) => { if (!open) { setReview(null); setConfirmed(false); } }} title={review?.kind === 'transfer' ? 'Transfer server ownership' : 'Record server owner'}
        description={review?.kind === 'transfer'
          ? `Transfer server ownership to ${review.name}. They will gain owner powers. You will remain an admin and lose owner powers.`
          : `Record ${review?.name ?? ''} as this server’s owner.`}
        confirmLabel={review?.kind === 'transfer' ? 'Transfer ownership' : 'Record server owner'} tone="primary" pending={change.isPending} confirmDisabled={!confirmed}
        onConfirm={() => { if (review !== null && confirmed && !change.isPending) change.mutate(review); }}>
        <label className="flex items-start gap-s2 t-small"><Input type="checkbox" className="size-s4 shrink-0 px-0" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />I reviewed the selected person and want to {review?.kind === 'transfer' ? 'transfer ownership to them' : 'record them as the server owner'}.</label>
      </ConfirmDialog>
    </AdminSection>
  );
}
