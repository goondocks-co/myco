import { Card, HealthDot, Skeleton, StatusChip, type HealthTone, type Tone } from '../../../design';
import type { useStatus } from '../../../hooks/use-status';
import { HEALTH_ANCHORS } from '../../../routes/nav';
import { AdminSection } from '../AdminFrame';
import { unreadLines, verdictOf, wellLines, type LineState, type Verdict, type WellLine } from './verdict';

const CHIP_TONE: Readonly<Record<LineState, Tone>> = { yes: 'ok', attention: 'warn', no: 'bad', unknown: 'neutral', failed: 'warn' };
const VERDICT_TONE: Readonly<Record<Verdict, HealthTone>> = { Yes: 'ok', 'Needs attention': 'warn', No: 'bad' };

/** One line: what it asks, what its answer rests on, and its answer. */
function Line({ line }: { line: WellLine }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-s4 gap-y-s2 border-t border-line px-s4 py-s3" data-well-line={line.key} data-well-state={line.state}>
      <div className="flex min-w-0 flex-[1_1_18rem] flex-col gap-s1">
        <span className="t-body font-medium text-ink">{line.label}</span>
        <span className="t-small text-muted">{line.detail}</span>
        {line.rows !== undefined && (
          <ul className="flex flex-col gap-s1 pt-s1" aria-label="What this server runs itself">
            {line.rows.map((row) => (
              <li key={row.label} className="flex flex-wrap items-center justify-between gap-s2 t-small text-ink-2">
                <span className="min-w-0">{row.label}</span>
                <StatusChip tone={row.ready ? 'ok' : 'warn'}>{row.ready ? 'Set up' : 'Not set up'}</StatusChip>
              </li>
            ))}
          </ul>
        )}
      </div>
      <StatusChip tone={CHIP_TONE[line.state]}>{line.answer}</StatusChip>
    </div>
  );
}

/**
 * "Is the server well?": one verdict with the sentence that explains it, then the five lines it follows from. A failed
 * read of the server's status says so on every line, and is never taken for Yes.
 */
export function ServerWell({ status, now, projectName }: { status: ReturnType<typeof useStatus>; now: number; projectName: (projectId: string) => string | null }) {
  const lines = status.data !== undefined && status.error === null ? wellLines({ status: status.data, now, projectName })
    : status.isPending ? null : unreadLines();
  const verdict = lines === null ? null : verdictOf(lines);
  return (
    <AdminSection id={HEALTH_ANCHORS.status} title="Is the server well?">
      <Card padding="flush" className="flex flex-col" data-server-well={verdict?.verdict ?? 'reading'}>
        {verdict === null || lines === null ? (
          <div role="status" aria-label="Reading this server’s status" className="flex flex-col gap-s3 p-s4">
            <Skeleton className="h-s5 w-1/4" />
            <Skeleton className="h-s4 w-3/4" />
          </div>
        ) : <>
          <div className="flex items-start gap-s3 p-s4" data-verdict="">
            <span className="flex h-lh shrink-0 items-center t-h2"><HealthDot tone={VERDICT_TONE[verdict.verdict]} label={verdict.verdict} /></span>
            <div className="flex min-w-0 flex-col gap-s1">
              <p className="t-h2 text-ink">{verdict.verdict}</p>
              <p className="t-small text-muted">{verdict.sentence}</p>
            </div>
          </div>
          {lines.map((line) => <Line key={line.key} line={line} />)}
        </>}
      </Card>
    </AdminSection>
  );
}
