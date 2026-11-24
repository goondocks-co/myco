import type { ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { agoWords } from '@goondocks/myco-shared/time-words';
import { Disclosure } from '../../../design';
import { useAgentPayers } from '../../../hooks/use-fleet';
import { AdminSection, RowCard } from '../AdminFrame';
import { useMemberNames } from '../members';
import type { LeafGroup } from './catalogue';
import { LeafControl } from './LeafControl';
import { ModelListingNote, ModelPresets } from './ModelPicker';
import { isRetired } from './retired';
import { TASK_SIZES_NOTE, TaskTiers } from './TaskTiers';
import type { LeafRow, TaskTierRow } from './wire';

/** The anchor of the job sizes fold. */
export const TASK_SIZES_ANCHOR = 'task-tiers';

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

/** Whether a group is as the server ships it, or what was changed, by whom and when. */
export function changedWords(group: LeafGroup, rows: ReadonlyMap<string, LeafRow>, nameOf: (id: string | null) => string | null, now: number): string {
  const changed = group.leaves.map((field) => rows.get(field.leaf)).filter((row): row is LeafRow => row?.configured === true && !row.retired);
  if (changed.length === 0) return 'Default';
  const latest = changed.reduce((a, b) => ((b.updatedAt ?? 0) > (a.updatedAt ?? 0) ? b : a));
  const who = nameOf(latest.updatedBy);
  const when = latest.updatedAt === null ? '' : ` ${agoWords(latest.updatedAt, now)}`;
  const by = `${who === null ? 'changed' : `changed by ${who}`}${when}`;
  return changed.length === 1 ? `${by.charAt(0).toUpperCase()}${by.slice(1)}` : `${changed.length} changed, last ${by}`;
}

/** One folded group: its name, one line on what it holds and whether it was changed, opened where a link points at it. */
function Fold({ id, label, summary, state, children }: { id: string; label: string; summary: string; state: string; children: ReactNode }) {
  const { hash } = useLocation();
  return (
    <div id={id} className="scroll-mt-s6 px-s4 py-s2" data-fold={id}>
      <Disclosure
        wide
        defaultOpen={hash === `#${id}`}
        summary={<>
          <span className="t-body font-medium text-ink">{label}</span>
          <span className="t-small text-muted">{summary}</span>
          <span className="t-meta text-faint" data-fold-state="">{state}</span>
        </>}
      >
        <div className="flex flex-col gap-s3 pb-s3 pt-s2">{children}</div>
      </Disclosure>
    </div>
  );
}

/**
 * Advanced, at the foot of Models: the model each agent a runner offers uses for each size of job, each task's size,
 * the agents tried next, the per-task overrides and search by meaning. Each folds away behind one line saying whether
 * it was changed.
 */
export function AdvancedGroups({ groups: all, rows, tiers }: { groups: readonly LeafGroup[]; rows: ReadonlyMap<string, LeafRow>; tiers: readonly TaskTierRow[] }) {
  const nameOf = useMemberNames();
  const payers = useAgentPayers();
  const now = Date.now();
  // An agent's model sizes are listed where a runner offers the agent, or where one of them was changed.
  const offered = new Set((payers.data?.agents ?? []).map((entry) => entry.agent));
  const groups = all.filter((group) => group.harness === undefined || offered.has(group.harness)
    || group.leaves.some((field) => rows.get(field.leaf)?.configured === true));
  const changedTasks = tiers.filter((row) => row.source !== 'task').length;
  const folds = groups.map((group) => (
    <Fold key={group.id} id={group.id} label={group.label} summary={group.note} state={changedWords(group, rows, nameOf, now)}>
      <GroupCard group={group} rows={rows} />
    </Fold>
  ));
  // Each task's size follows the model each agent uses for each size.
  const sizesAt = groups.reduce((at, group, index) => (group.harness === undefined ? at : index + 1), 0);
  const sizes = (
    <Fold key={TASK_SIZES_ANCHOR} id={TASK_SIZES_ANCHOR} label="Size of each job" summary={TASK_SIZES_NOTE} state={changedTasks === 0 ? 'Default' : `${changedTasks} changed`}>
      <TaskTiers tiers={tiers} />
    </Fold>
  );
  return (
    <AdminSection id="models-advanced" title="Advanced" description="Defaults that work untouched. Open one only if you have a reason to.">
      <RowCard label="Advanced">
        {[...folds.slice(0, sizesAt), sizes, ...folds.slice(sizesAt)]}
      </RowCard>
    </AdminSection>
  );
}
