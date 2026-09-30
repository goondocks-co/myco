import { Link as RouterLink } from 'react-router-dom';
import { Button, Card, Disclosure, errorWords, focusRing, HealthDot, Skeleton } from '../../design';
import { cn } from '../../lib/cn';
import type { AttentionAnswer, AttentionItem } from './wire';
import { ATTENTION_CHECKS, attentionWords, listed, type NeedsYouWords } from './words';

const TONE_LABEL = { warn: 'Needs attention', bad: 'Failing' } as const;

/** One thing that needs an administrator: a dot, the problem in one line, the detail in one more, and one way to act. */
export function NeedsYouItem({ tone, words }: { tone: AttentionItem['tone']; words: NeedsYouWords }) {
  return (
    <li className="flex gap-s3 border-t border-line pt-s3 first:border-t-0 first:pt-0" data-needs-you-item={tone}>
      <span className="flex h-lh shrink-0 items-center t-body"><HealthDot tone={tone} label={TONE_LABEL[tone]} /></span>
      <div className="flex min-w-0 flex-col gap-s1">
        <p className="t-body font-medium text-ink">{words.title}</p>
        <p className="t-small text-muted">{words.detail}</p>
        {words.action !== null && (
          <RouterLink to={words.action.to} className={cn('w-fit rounded-chip t-small font-medium text-primary hover:underline', focusRing)}>
            {words.action.label} →
          </RouterLink>
        )}
      </div>
    </li>
  );
}

export interface NeedsYouProps {
  answer: AttentionAnswer | undefined;
  pending: boolean;
  error: unknown;
  onRetry: () => void;
  now: number;
  projectName: (projectId: string) => string | null;
}

function itemsOf(answer: AttentionAnswer, now: number, projectName: NeedsYouProps['projectName']) {
  return answer.items.map((item, index) => ({ key: `${item.kind}:${index}`, tone: item.tone, words: attentionWords(item, now, projectName) }));
}

/** The checks that could not be read, in one quiet line, so an empty list is never taken for all clear. */
function Unchecked({ answer }: { answer: AttentionAnswer }) {
  if (answer.unavailable.length === 0) return null;
  const names = [...new Set(answer.unavailable.map((kind) => ATTENTION_CHECKS[kind]))];
  return <p className="t-small text-muted">Couldn’t check {listed(names)} just now.</p>;
}

function Failed({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const words = errorWords(error);
  return (
    <div role="alert" className="flex flex-wrap items-center gap-s2 t-small text-muted">
      <span>Couldn’t check what needs you: {words.title.replace(/\.$/, '').toLowerCase()}.</span>
      {words.retry && <Button size="sm" variant="ghost" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

/** "Needs you" on a wide screen: every item, or one line when there is nothing. */
export function NeedsYouPanel({ answer, pending, error, onRetry, now, projectName }: NeedsYouProps) {
  if (pending) {
    return (
      <Card role="status" aria-label="Checking what needs you" className="flex flex-col gap-s3" data-needs-you="">
        <Skeleton className="h-s5 w-2/5" />
        <Skeleton className="h-s4 w-4/5" />
      </Card>
    );
  }
  if (answer === undefined) {
    return <Card data-needs-you=""><Failed error={error} onRetry={onRetry} /></Card>;
  }
  const items = itemsOf(answer, now, projectName);
  if (items.length === 0) {
    return (
      <Card className="flex flex-col gap-s2" data-needs-you="">
        <h2 className="t-h2 text-ink">Nothing needs you</h2>
        <Unchecked answer={answer} />
      </Card>
    );
  }
  return (
    <Card className="flex flex-col gap-s3" data-needs-you="">
      <div className="flex items-baseline gap-s2">
        <h2 className="t-h2 text-ink">Needs you</h2>
        <span className="t-small text-muted">{items.length}</span>
      </div>
      <ul className="flex flex-col gap-s3">
        {items.map((item) => <NeedsYouItem key={item.key} tone={item.tone} words={item.words} />)}
      </ul>
      <Unchecked answer={answer} />
    </Card>
  );
}

/** "Needs you" on a phone: one line at the top of the page that opens to the items. */
export function NeedsYouSummary({ answer, pending, error, onRetry, now, projectName }: NeedsYouProps) {
  if (pending) return null;
  if (answer === undefined) return <Card data-needs-you=""><Failed error={error} onRetry={onRetry} /></Card>;
  const items = itemsOf(answer, now, projectName);
  if (items.length === 0) {
    return (
      <Card className="flex items-center gap-s3 px-s4 py-s3" data-needs-you="">
        <HealthDot tone="ok" label="All clear" />
        <h2 className="t-body font-medium text-ink">Nothing needs you</h2>
      </Card>
    );
  }
  const worst = items.some((item) => item.tone === 'bad') ? 'bad' : 'warn';
  const first = items[0]!;
  return (
    <Card className="px-s4 py-s3" data-needs-you="">
      <Disclosure
        summary={(
          <span className="flex min-w-0 items-center gap-s3 text-left">
            <HealthDot tone={worst} label={TONE_LABEL[worst]} />
            <span className="flex min-w-0 flex-col">
              <span className="t-body font-medium text-ink">{items.length === 1 ? '1 thing needs you' : `${items.length} things need you`}</span>
              <span className="t-small font-normal text-muted">{first.words.title}{items.length > 1 ? `, and ${items.length - 1} more` : ''}</span>
            </span>
          </span>
        )}
      >
        <ul className="flex flex-col gap-s3 pt-s2">
          {items.map((item) => <NeedsYouItem key={item.key} tone={item.tone} words={item.words} />)}
        </ul>
        <Unchecked answer={answer} />
      </Disclosure>
    </Card>
  );
}
