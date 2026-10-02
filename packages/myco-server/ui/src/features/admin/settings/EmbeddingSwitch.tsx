import { useState } from 'react';
import type { EmbeddingSwitchStatus } from '@goondocks/myco-shared/settings-contract';
import { Button, ConfirmDialog, Progress, StatusChip } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { switchRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { formatCount } from '../../../lib/format';
import { ago } from '../../today/words';

/** A model's name without its provider's prefix: `@cf/baai/bge-m3` reads as `bge-m3`. */
export const shortModel = (id: string): string => id.split('/').at(-1) ?? id;

const sizeWords = (dimensions: number | null): string => dimensions === null ? '' : ` (${dimensions} dimensions)`;

/** What a switch is estimated to cost, where its provider publishes a price. */
export function costWords(usd: number | null, tokens: number): string | null {
  if (usd === null) return null;
  const spend = usd < 0.01 ? 'under $0.01' : `about $${usd.toFixed(2)}`;
  return `Estimated cost: ${spend}, for about ${formatCount(tokens, 'token')}.`;
}

/** The switch in the reader's words: what search is moving to, how far it has come, and what search uses meanwhile. */
export function switchWords(sw: EmbeddingSwitchStatus, now: number): { headline: string; detail: string[] } {
  const to = `${shortModel(sw.model)}${sizeWords(sw.dimensions)}`;
  const share = sw.total === 0 ? 100 : Math.floor((sw.done / sw.total) * 100);
  const count = `${sw.done.toLocaleString()} of ${formatCount(sw.total, 'source')} done (${share}%)`;
  const meanwhile = sw.from === null
    ? 'Search matches words only until it is done.'
    : `Search keeps using ${shortModel(sw.from.model)} until every source is done, then moves to ${shortModel(sw.model)} on its own.`;
  const cost = costWords(sw.estimatedUsd, sw.estimatedTokens);
  const started = `Started ${ago(sw.startedAt, now)}.`;
  if (sw.state === 'paused') {
    const held = sw.from === null ? 'Search matches words only meanwhile.' : `Search keeps using ${shortModel(sw.from.model)} meanwhile.`;
    return { headline: `Rebuilding search with ${to} is paused at ${count}.`, detail: [sw.reason ?? 'It waits for you to resume it.', held, started] };
  }
  return { headline: `Rebuilding search with ${to}: ${count}.`, detail: [meanwhile, started, ...(cost === null ? [] : [cost])] };
}

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
    <div className="flex w-full flex-col gap-s2" data-embedding-switch={sw.state}>
      <p className="flex flex-wrap items-center gap-s2 t-body text-ink">
        <StatusChip tone={sw.state === 'paused' ? 'warn' : 'ok'}>{sw.state === 'paused' ? 'Paused' : 'Rebuilding'}</StatusChip>
        <span>{words.headline}</span>
      </p>
      <Progress done={sw.done} total={Math.max(sw.total, 1)} label={`Sources rebuilt with ${shortModel(sw.model)}`} />
      {words.detail.map((line) => <p key={line} className={`t-small ${sw.state === 'paused' && line === sw.reason ? 'text-bad' : 'text-muted'}`}>{line}</p>)}
      {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
      {admin && (
        <div className="flex flex-wrap gap-s2">
          {sw.state === 'paused' && (
            <Button size="sm" variant="primary" pending={actions.resumeSwitch.isPending} onClick={() => {
              setError(null);
              actions.resumeSwitch.mutate({ id: sw.id }, { onError: (err) => setError(switchRefusalText(err)) });
            }}>Resume</Button>
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
