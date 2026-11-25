import { useRef, useState } from 'react';
import { Button } from '../../../design';
import { useNow } from '../../../hooks/use-today';
import { useCurationPreview } from '../../../hooks/use-work';
import { ApiError } from '../../../lib/api';
import { runPath } from '../../../routes/nav';
import { OnwardLink } from '../../work/OutcomeCard';
import { refusalOf } from '../../work/RunTask';
import type { CurationContinuation, CurationPreviewAnswer } from '../../work/wire';
import { isDailyLimit, laterWords } from '../../work/words';
import { SettingRow } from '../AdminFrame';

const CURATION_PREVIEW_NOTE = 'See what curation would do with one group of overlapping spores, whether the switch is on or off. A preview changes nothing: no spore is merged, split, rewritten or retired. It spends model tokens, within a daily allowance of previews.';
/** Beside a continued preview: what the next one skips, and that nothing outside this page remembers it. */
const CURATION_SITTING_NOTE = 'The next preview skips a group whose spores were all shown here already. A preview records nothing, so leaving this page starts again from the first group.';

/** What came of the last ask: an answer, or a refusal already in the reader's words. */
type Shown = { answer: CurationPreviewAnswer } | { refused: string };

/** A refusal of a preview in the reader's words; a daily allowance names when it resets where the server says. */
function previewRefusal(error: Error, now: number): string {
  if (error instanceof ApiError && error.status === 429 && isDailyLimit(error.body)) {
    const spent = `Your previews in this Project are used up (${error.body.perDay} in 24 hours).`;
    return error.body.resetsAt === null ? `${spent} You can preview again once an earlier preview is a day old.` : `${spent} You can preview again ${laterWords(error.body.resetsAt, now)}.`;
  }
  if (error instanceof ApiError && error.code === 'invalid_curation_continuation') return 'The place to look further from is no longer valid. Preview again to start from the beginning.';
  return refusalOf(error, now, 'curate-spores').words;
}

function AnswerLine({ projectId, answer }: { projectId: string; answer: CurationPreviewAnswer }) {
  if (answer.outcome === 'group_found') return <span className="flex flex-wrap items-baseline gap-x-s3 gap-y-s1">
    <span>{answer.queued ? 'Preview queued. It starts when a machine is free.' : 'Preview started.'}</span>
    <OnwardLink to={runPath(projectId, answer.runId)}>Open the preview</OnwardLink>
  </span>;
  if (answer.outcome === 'vectors_pending') return <span>The spores checked aren’t searchable for similarity yet, so no group could be found. Try again once search has caught up.</span>;
  return <span>{answer.continuation === null
    ? 'No group of overlapping spores needs curation now.'
    : 'No group in this stretch of spores needs curation. Look further to check the next stretch.'}</span>;
}

/**
 * An administrator's preview of what curation would do in a Project, on or off. Each found group or empty stretch
 * hands back where to continue and which spores were shown; that place lives only here, so leaving the page starts the next preview afresh.
 */
export function CurationPreview({ projectId }: { projectId: string }) {
  const preview = useCurationPreview(projectId);
  const now = useNow();
  // Where the next ask continues from, and whether it follows a found group or an empty stretch.
  const [from, setFrom] = useState<{ continuation: CurationContinuation; found: boolean } | null>(null);
  const [shown, setShown] = useState<Shown | null>(null);
  // One ask at a time: set before the request goes out, so a second click in the same tick sends nothing.
  const asking = useRef(false);
  const label = from === null ? 'Preview one group' : from.found ? 'Preview the next group' : 'Look further';
  const start = () => {
    if (asking.current) return;
    asking.current = true;
    preview.mutate(from?.continuation ?? null, {
      onSuccess: (answer) => {
        setShown({ answer });
        setFrom(answer.continuation === null ? null : { continuation: answer.continuation, found: answer.outcome === 'group_found' });
      },
      onError: (error) => {
        if (error instanceof ApiError && error.code === 'invalid_curation_continuation') setFrom(null);
        setShown({ refused: previewRefusal(error, now) });
      },
      onSettled: () => { asking.current = false; },
    });
  };
  return (
    <SettingRow
      setting="curation.preview"
      label="Preview curation"
      note={CURATION_PREVIEW_NOTE}
      refused={shown !== null && 'refused' in shown}
      status={shown !== null && 'refused' in shown ? shown.refused : undefined}
      details={<>
        {shown !== null && 'answer' in shown && <p role="status" className="t-small text-ink-2" data-curation-preview-outcome={shown.answer.outcome}>
          <AnswerLine projectId={projectId} answer={shown.answer} />
        </p>}
        {from !== null && <p className="t-meta text-muted" data-curation-preview-sitting="">{CURATION_SITTING_NOTE}</p>}
      </>}
      control={<Button pending={preview.isPending} onClick={start} data-curation-preview="">{label}</Button>}
    />
  );
}
