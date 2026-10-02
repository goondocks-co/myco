import { useState } from 'react';
import type { EmbeddingSwitchEstimate, EmbeddingSwitchStatus, PassedOverList, PassedOverSourceView } from '@goondocks/myco-shared/settings-contract';
import { Button, ConfirmDialog, Progress, StatusChip } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { switchRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { formatCount } from '../../../lib/format';
import { ago, when } from '../../today/words';

/** A model's name without its provider's prefix: `@cf/baai/bge-m3` reads as `bge-m3`. */
export const shortModel = (id: string): string => id.split('/').at(-1) ?? id;

const sizeWords = (dimensions: number | null): string => dimensions === null ? '' : ` (${dimensions} dimensions)`;

/** An amount in US dollars as a person reads an estimate of it. */
const dollars = (usd: number): string => usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`;

/** What a switch is estimated to cost, where its provider publishes a price. */
export function costWords(usd: number | null, tokens: number): string | null {
  return usd === null ? null : `Estimated cost: ${dollars(usd)}, for about ${formatCount(tokens, 'token')}.`;
}

const TYPE_WORDS: Readonly<Record<string, string>> = { session: 'Session', spore: 'Spore', plan: 'Plan', skill: 'Skill' };

/** One passed-over source in the reader's words: what it is, where, and why. */
export const passedOverWords = (source: PassedOverSourceView): string =>
  `${TYPE_WORDS[source.type] ?? 'Source'} “${source.title}”${source.projectName === null ? '' : ` in ${source.projectName}`}: ${source.reason}`;

/**
 * The sources a list names, each on its own line, and how many more there are. Shown wherever search by meaning leaves
 * sources out: the switch's confirmation and progress, and Health.
 */
export function PassedOverSources({ list, lede }: { list: PassedOverList; lede: string }) {
  if (list.count === 0) return null;
  const more = list.count - list.sources.length;
  return (
    <div className="flex flex-col gap-s1" data-passed-over="">
      <p className="t-small text-ink-2">{lede}</p>
      <ul className="flex list-disc flex-col gap-s1 pl-s5 t-small text-muted">
        {list.sources.map((source) => <li key={`${source.projectId}:${source.type}:${source.title}:${source.reason}`}>{passedOverWords(source)}</li>)}
      </ul>
      {more > 0 && <p className="t-small text-muted">{`And ${formatCount(more, 'more source')}.`}</p>}
    </div>
  );
}

/** What a switch would read and cost, as the confirmation states it before it starts. */
export function estimateWords(estimate: EmbeddingSwitchEstimate): string {
  const reads = `It reads about ${formatCount(estimate.sources, 'source')}, about ${formatCount(estimate.estimatedTokens, 'token')} in all.`;
  return estimate.estimatedUsd === null
    ? `${reads} No price is published for this model.`
    : `${reads} Estimated cost: ${dollars(estimate.estimatedUsd)}.`;
}

export interface SwitchLine { text: string; tone: 'bad' | 'warn' | 'muted' }

/**
 * The switch in the reader's words: its state, what search is moving to, how far it has come, why it waits or has not
 * moved, the sources left out, and what search uses meanwhile.
 */
export function switchWords(sw: EmbeddingSwitchStatus, now: number): { chip: string; headline: string; detail: SwitchLine[] } {
  const to = `${shortModel(sw.model)}${sizeWords(sw.dimensions)}`;
  const share = sw.total === 0 ? 100 : Math.floor((sw.done / sw.total) * 100);
  const count = `${sw.done.toLocaleString()} of ${formatCount(sw.total, 'source')} done (${share}%)`;
  const from = sw.from === null ? null : shortModel(sw.from.model);
  const muted = (text: string): SwitchLine => ({ text, tone: 'muted' });
  const started = muted(`Started ${ago(sw.startedAt, now)}.`);
  if (sw.state === 'paused') {
    return {
      chip: 'Paused',
      headline: `Rebuilding search with ${to} is paused at ${count}.`,
      detail: [{ text: sw.reason ?? 'It waits for you to resume it.', tone: 'bad' },
        muted(from === null ? 'Search matches words only meanwhile.' : `Search keeps using ${from} meanwhile.`), started],
    };
  }
  const meanwhile = muted(from === null
    ? 'Search matches words only until it is done.'
    : `Search keeps using ${from} until every source is done, then moves to ${shortModel(sw.model)} on its own.`);
  const cost = costWords(sw.estimatedUsd, sw.estimatedTokens);
  const waiting: SwitchLine[] = sw.retryAt === null ? [] : [{ text: `${sw.reason ?? 'The new model failed.'} Next try ${when(sw.retryAt, now)}.`, tone: 'warn' }];
  const stalled: SwitchLine[] = sw.stalled === null ? [] : [{ text: sw.stalled, tone: 'warn' }];
  return {
    chip: sw.retryAt === null ? 'Rebuilding' : 'Waiting',
    headline: `Rebuilding search with ${to}: ${count}.`,
    detail: [...waiting, ...stalled, meanwhile, started, ...(cost === null ? [] : [muted(cost)])],
  };
}

const TONE = { bad: 'text-bad', warn: 'text-ink-2', muted: 'text-muted' } as const;

/**
 * A switch of the embedding model under way, with its progress and, for an admin, Cancel and Resume. Shown on Settings
 * under the embedding model and on Health.
 */
export function EmbeddingSwitchPanel({ sw, now }: { sw: EmbeddingSwitchStatus; now: number }) {
  const admin = useIsAdmin();
  const actions = useSettingsActions();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const words = switchWords(sw, now);
  const from = sw.from === null ? 'no model' : shortModel(sw.from.model);
  return (
    <div className="flex w-full flex-col gap-s2" data-embedding-switch={sw.state} data-embedding-waiting={sw.retryAt === null ? undefined : ''}>
      <p className="flex flex-wrap items-center gap-s2 t-body text-ink">
        <StatusChip tone={sw.state === 'paused' ? 'warn' : sw.retryAt === null ? 'ok' : 'warn'}>{words.chip}</StatusChip>
        <span>{words.headline}</span>
      </p>
      <Progress done={sw.done} total={Math.max(sw.total, 1)} label={`Sources rebuilt with ${shortModel(sw.model)}`} />
      {words.detail.map((line) => <p key={line.text} className={`t-small ${TONE[line.tone]}`}>{line.text}</p>)}
      <PassedOverSources list={sw.passedOver} lede={`${formatCount(sw.passedOver.count, 'source')} will have no search by meaning once search moves to ${shortModel(sw.model)}:`} />
      {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
      {admin && (
        <div className="flex flex-wrap gap-s2">
          {(sw.state === 'paused' || sw.retryAt !== null) && (
            <Button size="sm" variant="primary" pending={actions.resumeSwitch.isPending} onClick={() => {
              setError(null);
              actions.resumeSwitch.mutate({ id: sw.id }, { onError: (err) => setError(switchRefusalText(err)) });
            }}>{sw.state === 'paused' ? 'Resume' : 'Try now'}</Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => { setError(null); setConfirming(true); }}>Cancel the switch</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title="Cancel the switch?"
        description={`Search keeps using ${from}. The ${shortModel(sw.model)} results built so far are removed.`}
        confirmLabel="Cancel the switch"
        pending={actions.cancelSwitch.isPending}
        error={actions.cancelSwitch.isError ? switchRefusalText(actions.cancelSwitch.error) : null}
        onConfirm={() => actions.cancelSwitch.mutate({ id: sw.id }, { onSuccess: () => setConfirming(false) })}
      />
    </div>
  );
}
