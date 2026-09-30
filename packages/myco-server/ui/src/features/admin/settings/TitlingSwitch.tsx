import { Button, Switch } from '../../../design';
import { useSetTitlingBackfill, useTitlingBackfill } from '../../../hooks/use-settings';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import { progressWords } from './titling';

/** The switch's anchor on Myco's work. */
export const TITLING_ANCHOR = 'titling';

/**
 * "Title imported sessions": the switch that titles sessions brought in from a
 * machine's history, read from and written to the server's own titling route,
 * with where titling stands beneath it.
 */
export function TitlingSwitch() {
  const progress = useTitlingBackfill();
  const set = useSetTitlingBackfill();
  const p = progress.data;
  const refused = set.isError;
  const wanted = set.variables;

  let control;
  if (p !== undefined) {
    control = (
      <Switch
        id="title-imported-sessions"
        aria-label="Title imported sessions"
        checked={p.backfillEnabled}
        disabled={set.isPending}
        onCheckedChange={(checked) => set.mutate(checked)}
      />
    );
  } else if (progress.isError) {
    control = <Button size="sm" pending={progress.isFetching} onClick={() => void progress.refetch()}>Retry</Button>;
  } else {
    control = <Switch aria-label="Title imported sessions" checked={false} disabled onCheckedChange={() => undefined} />;
  }

  return (
    <AdminSection id={TITLING_ANCHOR} title="Session titles" description="Myco gives each session a title and a summary once it ends.">
      <RowCard>
        <SettingRow
          setting="titling-backfill"
          label="Title imported sessions"
          htmlFor={p !== undefined ? 'title-imported-sessions' : undefined}
          note="Sessions brought in from a machine’s history arrive without a title. This titles them a few at a time, newest first, within the same daily limit as every other title."
          status={p === undefined && progress.isError ? 'Couldn’t read where titling stands just now.' : undefined}
          control={control}
        />
        {refused && (
          <div role="alert" className="flex flex-wrap items-center gap-s2 px-s4 py-s3 t-small text-bad">
            <span>{`The server didn’t turn titling imported sessions ${wanted ? 'on' : 'off'}.`}</span>
            <Button size="sm" variant="ghost" disabled={set.isPending} onClick={() => set.mutate(wanted ?? !(p?.backfillEnabled ?? false))}>Try again</Button>
          </div>
        )}
        {p !== undefined && (
          <p className="px-s4 py-s4 t-small text-muted" data-titling-progress="">{progressWords(p)}</p>
        )}
      </RowCard>
    </AdminSection>
  );
}
