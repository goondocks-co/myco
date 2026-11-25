import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { HOSTED_BACKUP_PAUSE_NOTICE, NATIVE_BACKUP_NOTICE } from '@goondocks/myco-shared/backup-words';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Disclosure } from '../../../design';
import { useAgentPayers } from '../../../hooks/use-fleet';
import { permissionOf, useMe } from '../../../hooks/use-me';
import { useTitlingBackfill } from '../../../hooks/use-settings';
import { AdminSection, RowCard } from '../AdminFrame';
import { useMemberNames } from '../members';
import { Ownership } from '../people/Ownership';
import { RawClaims } from '../people/RawClaims';
import { usePersonName } from '../people/PeoplePage';
import { BACKUP_COPIES_ANCHOR, BackupsSection } from './Backups';
import { ADVANCED_FOLDS, groupsIn, type AdvancedFoldId, type LeafGroup } from './catalogue';
import { LeafControl } from './LeafControl';
import { ModelListingNote, ModelPresets } from './ModelPicker';
import { isRetired } from './retired';
import { TASK_SIZES_NOTE, TaskTiers } from './TaskTiers';
import { TITLING_ANCHOR, TitlingSwitch } from './TitlingSwitch';
import { Upkeep } from './Upkeep';
import type { LeafRow, SettingsAnswer } from './wire';

/** The Advanced page's own anchor. */
export const ADVANCED_ANCHOR = 'advanced-settings';
/** The anchor of the job sizes group, under Model sizes. */
export const TASK_SIZES_ANCHOR = 'task-tiers';
/** Anchors under Advanced that are not settings groups, each with the fold that holds it. */
export const ADVANCED_ANCHORS: ReadonlyArray<readonly [anchor: string, fold: AdvancedFoldId]> = [
  [TASK_SIZES_ANCHOR, 'model-sizes'],
  [TITLING_ANCHOR, 'new-and-past'],
  ['ownership', 'owner-actions'],
  ['raw-claims', 'owner-actions'],
  [BACKUP_COPIES_ANCHOR, 'backups'],
];

/** One settings group's live controls in one card: the agent's model listing and presets first, where it sets an agent's models. */
export function GroupCard({ group, rows }: { group: LeafGroup; rows: ReadonlyMap<string, LeafRow> }) {
  const live = group.leaves.filter((field) => !isRetired(field, rows.get(field.leaf)));
  if (live.length === 0) return null;
  return (
    <RowCard label={group.label}>
      {group.harness !== undefined && <ModelListingNote harness={group.harness} />}
      {group.harness !== undefined && <ModelPresets harness={group.harness} />}
      {live.map((field) => <LeafControl key={field.leaf} field={field} row={rows.get(field.leaf)} />)}
    </RowCard>
  );
}

const ALL_DEFAULT = 'All default';

/** Whether groups are as the server ships them, or what was changed, by whom and when. */
export function changedWords(groups: readonly LeafGroup[], rows: ReadonlyMap<string, LeafRow>, nameOf: (id: string | null) => string | null, now: number): string {
  const changed = groups.flatMap((group) => group.leaves).map((field) => rows.get(field.leaf)).filter((row): row is LeafRow => row?.configured === true && !row.retired);
  if (changed.length === 0) return ALL_DEFAULT;
  const latest = changed.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
  const who = nameOf(latest.updatedBy);
  const when = latest.updatedAt === null ? '' : ` ${agoWords(latest.updatedAt, now)}`;
  const by = `${who === null ? 'changed' : `changed by ${who}`}${when}`;
  return changed.length === 1 ? `${by.charAt(0).toUpperCase()}${by.slice(1)}` : `${changed.length} changed, last ${by}`;
}

/** One folded group: its name, one line on what it holds and whether it was changed, opened where a link points at it or into it. */
function Fold({ id, label, summary, state, inside, children }: { id: string; label: string; summary: string; state: string; inside: readonly string[]; children: ReactNode }) {
  const { hash } = useLocation();
  const anchor = decodeURIComponent(hash.replace(/^#/, ''));
  return (
    <div id={id} className="scroll-mt-s6 px-s4 py-s2" data-fold={id}>
      <Disclosure
        wide
        defaultOpen={anchor === id || inside.includes(anchor)}
        summary={<>
          <span className="t-body font-medium text-ink">{label}</span>
          <span className="t-small text-muted">{summary}</span>
          <span className="t-meta text-faint" data-fold-state="">{state}</span>
        </>}
      >
        <div className="flex flex-col gap-s6 pb-s4 pt-s3">{children}</div>
      </Disclosure>
    </div>
  );
}

/** A settings group inside a fold: its name, one line on it, and its controls. */
function Subgroup({ group, rows }: { group: LeafGroup; rows: ReadonlyMap<string, LeafRow> }) {
  if (group.leaves.every((field) => isRetired(field, rows.get(field.leaf)))) return null;
  return (
    <AdminSection id={group.id} nested title={group.label} description={group.note}>
      <GroupCard group={group} rows={rows} />
    </AdminSection>
  );
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const numberOf = (rows: ReadonlyMap<string, LeafRow>, leaf: string): number | null => {
  const value = rows.get(leaf)?.effective;
  return typeof value === 'number' ? value : null;
};

/** What Backups says while folded: whether backups run on their own, and what one costs while it runs on this server. */
function backupSummary(rows: ReadonlyMap<string, LeafRow>, target: string | null): { summary: string; cadence: string } {
  const every = numberOf(rows, 'backup.auto_interval_hours');
  const cost = target === 'cloudflare' ? 'A scheduled backup pauses the dashboard while it runs: nothing can be read or saved until it ends. Cloudflare can also put the database back to a recent point without one.'
    : target === 'bun' ? NATIVE_BACKUP_NOTICE
    : `On a hosted server, a scheduled backup pauses the dashboard while it runs. ${HOSTED_BACKUP_PAUSE_NOTICE}`;
  return { summary: `How often this server backs itself up and what it keeps. ${cost}`, cadence: every === null ? 'Automatic backups off' : `Every ${plural(every, 'hour')}` };
}

/** What How long things are kept says while folded, from what the server keeps now. */
function keptSummary(rows: ReadonlyMap<string, LeafRow>): string {
  const raw = numberOf(rows, 'retention.raw_days');
  const runs = numberOf(rows, 'agent.run_retention_days');
  return [
    raw === null ? 'Raw transcripts stay where they are.' : `Raw transcripts move to archive after ${plural(raw, 'day')}.`,
    runs === null ? null : `The record of each task Myco ran is kept for ${plural(runs, 'day')}.`,
    'Sessions, knowledge and plans are kept for good.',
  ].filter((line) => line !== null).join(' ');
}

/**
 * Advanced: every setting that works untouched, in eight folded groups; Backups and Upkeep also hold what this server
 * keeps and runs, beside the settings that control it. Each fold says in one line what it holds and
 * whether anything in it was changed, by whom and when; a link to a fold, or to a group inside one, opens it.
 */
export function AdvancedSection({ answer, rows }: { answer: SettingsAnswer; rows: ReadonlyMap<string, LeafRow> }) {
  const nameOf = useMemberNames();
  const payers = useAgentPayers();
  const me = useMe();
  const nameOfPerson = usePersonName();
  const owner = permissionOf(me.data, 'roles').allowed;
  const titling = useTitlingBackfill();
  const now = Date.now();
  // An agent's model sizes are listed where a runner offers the agent, or where one of them was changed.
  const offered = new Set((payers.data?.agents ?? []).map((entry) => entry.agent));
  const shown = (group: LeafGroup) => group.harness === undefined || offered.has(group.harness)
    || group.leaves.some((field) => rows.get(field.leaf)?.configured === true);
  const changedTasks = answer.taskTiers.filter((row) => row.source !== 'task').length;
  const target = answer.embedding?.target ?? null;

  const folds = ADVANCED_FOLDS.map((fold) => {
    const groups = groupsIn(fold.id).filter(shown);
    const inside = [...groups.map((group) => group.id), ...ADVANCED_ANCHORS.filter(([, home]) => home === fold.id).map(([anchor]) => anchor)];
    const backups = fold.id === 'backups' ? backupSummary(rows, target) : null;
    const summary = backups?.summary ?? (fold.id === 'kept' ? keptSummary(rows) : fold.summary);
    const changes = changedWords(groups, rows, nameOf, now);
    const extra = fold.id === 'backups' ? backups!.cadence
      : fold.id === 'model-sizes' && changedTasks > 0 ? `${plural(changedTasks, 'job size')} changed`
      : fold.id === 'new-and-past' && titling.data !== undefined ? `imported sessions ${titling.data.backfillEnabled ? 'get' : 'don’t get'} titles`
      : null;
    // A group's own line of state stands in for "All default": it names something the change summary does not cover.
    const state = fold.id === 'owner-actions' ? 'Rarely needed' : [extra, extra !== null && changes === ALL_DEFAULT ? null : changes].filter(Boolean).join(' · ');
    const subgroups = groups.map((group) => <Subgroup key={group.id} group={group} rows={rows} />);
    // Each job's size follows the model each agent uses for each size.
    const sizesAt = groups.reduce((at, group, index) => (group.harness === undefined ? at : index + 1), 0);
    return (
      <Fold key={fold.id} id={fold.id} label={fold.label} summary={summary} state={state} inside={inside}>
        {fold.id === 'model-sizes' ? <>
          {subgroups.slice(0, sizesAt)}
          <AdminSection id={TASK_SIZES_ANCHOR} nested title="Size of each job" description={TASK_SIZES_NOTE}><TaskTiers tiers={answer.taskTiers} /></AdminSection>
          {subgroups.slice(sizesAt)}
        </> : fold.id === 'backups' ? <>
          <BackupsSection target={target} />
          {subgroups}
        </> : fold.id === 'upkeep' ? <>
          <Upkeep />
          {subgroups}
        </> : subgroups}
        {fold.id === 'new-and-past' && <TitlingSwitch nested />}
        {fold.id === 'owner-actions' && <>
          {me.data?.owner !== undefined && <Ownership nested isOwner={me.data.owner} nameOfCandidate={(candidate) => nameOfPerson({ id: candidate.memberId, label: candidate.label })} />}
          {owner && <RawClaims nested />}
          {!owner && <p className="t-small text-muted">Only this server’s owner can claim raw data with no recorded uploader.</p>}
        </>}
      </Fold>
    );
  });
  return (
    <AdminSection id={ADVANCED_ANCHOR} title="Advanced" description="Defaults that work untouched. Open a group only if you have a reason to.">
      <RowCard label="Advanced">{folds}</RowCard>
    </AdminSection>
  );
}
