import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from './ui/badge';
import { Button } from './ui/button';
import { MasterDetailSplit } from './ui/master-detail-split';
import { PageLoading } from './ui/page-loading';
import { Panel } from './ui/panel';
import { Row } from './ui/row';
import { inlineLink } from './ui/inline-link';
import { CANDIDATE_PAGE_SIZE, useReviewCandidate, useSkillCandidates, type CandidateReviewStatus, type SkillCandidate } from '../hooks/use-skill-candidates';
import { ApiError } from '../lib/api';
import { formatDateTime } from '../lib/format';

const LABELS: Record<SkillCandidate['status'], string> = { identified: 'Needs review', approved: 'Approved', dismissed: 'Dismissed', generated: 'Generated' };

function Evidence({ raw, label, empty }: { raw: string; label: string; empty: string }) {
  let values: unknown;
  try { values = JSON.parse(raw); } catch { values = null; }
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) return <p role="alert">The recorded {label} could not be read.</p>;
  return values.length === 0 ? <p>{empty}</p> : <ul className="space-y-1 font-mono text-xs">{values.map((value, index) => <li key={`${index}:${value}`} className="break-all">{value}</li>)}</ul>;
}

export function SkillCandidates({ projectId }: { projectId: string }) {
  const [status, setStatus] = useState<SkillCandidate['status']>('identified');
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const query = useSkillCandidates(projectId, status, offset);
  const review = useReviewCandidate(projectId);
  const candidate = query.data?.candidates.find((row) => row.id === selected);
  const decide = (next: CandidateReviewStatus) => {
    if (candidate) review.mutate({ id: candidate.id, revision: candidate.revision, status: next });
  };
  const select = (id: string) => { review.reset(); setSelected(id); };
  return <div className="space-y-4">
    <p className="font-sans text-sm text-on-surface-variant">Review proposed procedures and approve the ones Myco should develop into skills.</p>
    <div className="flex flex-wrap items-center gap-3">
      <label className="font-sans text-sm">Status <select aria-label="Candidate status" value={status} disabled={review.isPending}
        className="ml-2 rounded-md border border-outline-variant/30 bg-surface px-2 py-1"
        onChange={(event) => { setStatus(event.target.value as SkillCandidate['status']); setOffset(0); setSelected(null); review.reset(); }}>
        {Object.entries(LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
      </select></label>
      {review.data && <span role="status" className="font-sans text-sm text-tertiary">Candidate {LABELS[review.data.candidate.status].toLowerCase()}.</span>}
      {review.error && <span role="alert" className="font-sans text-sm text-tertiary">{review.error instanceof ApiError && review.error.status === 409
        ? 'This candidate changed. Review the updated details before deciding again.' : 'The review could not be saved. Try again.'}</span>}
    </div>
    <PageLoading isLoading={query.isPending} error={query.error}>
      <div className="min-h-[50vh] rounded-lg border border-outline-variant/20">
        <MasterDetailSplit hasSelection={candidate !== undefined} onCloseMobileDetail={() => setSelected(null)} masterAriaLabel="Skill candidates" detailAriaLabel="Candidate"
          master={<>
            {query.data?.candidates.length === 0 ? <p className="p-4 font-sans text-sm text-on-surface-variant">No candidates with this status.</p> : <div role="table" aria-label="Skill candidates">
              {query.data?.candidates.map((row) => <Row key={row.id} isActive={row.id === selected} onClick={() => { if (!review.isPending) select(row.id); }}>
                <div className="font-sans text-sm text-on-surface">{row.topic}</div>
                <div className="mt-1 font-mono text-xs text-on-surface-variant">{Math.round(row.confidence * 100)}% confidence</div>
              </Row>)}
            </div>}
            <div className="flex gap-2 p-3">
              <Button size="sm" variant="outline" disabled={offset === 0 || review.isPending} onClick={() => { setOffset(Math.max(0, offset - CANDIDATE_PAGE_SIZE)); setSelected(null); }}>Previous</Button>
              <Button size="sm" variant="outline" disabled={!query.data?.hasMore || review.isPending} onClick={() => { setOffset(offset + CANDIDATE_PAGE_SIZE); setSelected(null); }}>Next</Button>
            </div>
          </>}
          detail={candidate === undefined ? <p className="font-sans text-sm text-on-surface-variant">Select a candidate to review its evidence.</p> : <div className="space-y-4">
            <h2 className="font-serif text-xl">{candidate.topic}</h2>
            <Badge variant="secondary">{LABELS[candidate.status]}</Badge>
            <Panel title="Why this skill"><p className="whitespace-pre-wrap font-sans text-sm">{candidate.rationale}</p></Panel>
            <Panel title="Source references"><Evidence raw={candidate.sourceIds} label="sources" empty="No source references recorded." /></Panel>
            <Panel title="Quality assessment">
              {candidate.qualityScore !== null && <p className="mb-2 font-sans text-sm">Quality score: {candidate.qualityScore}</p>}
              <Evidence raw={candidate.qualityFailures} label="quality concerns" empty="No quality concerns recorded." />
            </Panel>
            <Panel title="Existing skill coverage"><Evidence raw={candidate.coverageMatches} label="coverage matches" empty="No overlapping skills recorded." /></Panel>
            {candidate.reconciliationReason && <Panel title="Latest assessment"><p className="font-sans text-sm">{candidate.reconciliationReason}</p></Panel>}
            {candidate.approvedAt !== null && <p className="font-sans text-xs text-on-surface-variant">First approved {formatDateTime(candidate.approvedAt)}.</p>}
            {candidate.status === 'generated' ? <p className="font-sans text-sm">This candidate has generated a skill. {candidate.skillId
              ? <Link className={inlineLink} to={`/p/${encodeURIComponent(projectId)}/skills/${encodeURIComponent(candidate.skillId)}`}>View skill</Link>
              : 'Review the published skill in the Skills tab.'}</p> : <div className="flex flex-wrap gap-2">
              <Button size="sm" disabled={review.isPending || candidate.status === 'approved'} onClick={() => decide('approved')}>Approve</Button>
              <Button size="sm" variant="outline" disabled={review.isPending || candidate.status === 'dismissed'} onClick={() => decide('dismissed')}>Dismiss</Button>
              {candidate.status !== 'identified' && <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => decide('identified')}>Return to review</Button>}
            </div>}
          </div>} />
      </div>
    </PageLoading>
  </div>;
}
