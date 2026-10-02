import { useState } from 'react';
import { REASONING_TIERS, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { Button, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { AdminSection, RowCard, SettingRow } from '../AdminFrame';
import type { TaskTierRow } from './wire';

/** The effective tier is server-owned; an edit patches one task against the live overrides. */
export function TaskTiers({ tiers }: { tiers: readonly TaskTierRow[] }) {
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const [error, setError] = useState<{ task: string; message: string } | null>(null);
  const pending = actions.setTaskTier.isPending;

  const save = (task: string, tier: ReasoningTier | null) => {
    if (!admin || pending) return;
    setError(null);
    actions.setTaskTier.mutate({ task, tier }, {
      onError: (failure) => setError({ task, message: settingsRefusalText(failure) }),
    });
  };

  return (
    <AdminSection id="task-tiers" title="Task tiers" description="Each task starts at its declared tier. Choose a tier here to override it; reset restores the task’s declared tier.">
      <RowCard label="Task tiers">
        {tiers.map(({ task, tier, source }) => (
          <SettingRow
            key={task}
            setting={`task-tier-${task}`}
            label={task}
            htmlFor={`task-tier-${task}`}
            status={error?.task === task ? error.message : source === 'task-override' ? 'Task override' : 'Task default'}
            refused={error?.task === task}
            control={<div className="flex w-full items-center gap-s2">
              <Select
                id={`task-tier-${task}`}
                label={`${task} tier`}
                value={tier}
                disabled={!admin || pending}
                options={REASONING_TIERS.map((option) => ({ value: option, label: option[0]!.toUpperCase() + option.slice(1) }))}
                onValueChange={(option) => save(task, option as ReasoningTier)}
              />
              {source === 'task-override' && admin && (
                <Button size="sm" aria-label={`Reset ${task} tier`} disabled={pending} onClick={() => save(task, null)}>Reset</Button>
              )}
            </div>}
          />
        ))}
      </RowCard>
    </AdminSection>
  );
}
