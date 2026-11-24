import { useState } from 'react';
import { REASONING_TIERS, type ReasoningTier } from '@goondocks/myco-shared/execution-profile';
import { Button, Select } from '../../../design';
import { useIsAdmin } from '../../../hooks/use-me';
import { settingsRefusalText, useSettingsActions } from '../../../hooks/use-settings';
import { RowCard, SettingRow } from '../AdminFrame';
import { SIZE_WORDS } from './catalogue';
import type { TaskTierRow } from './wire';

/** The note above the task sizes, where they are shown. */
export const TASK_SIZES_NOTE = 'Each task starts at the size it is declared with. Choose a size here to change it; Reset restores the declared size.';

/** Each task's job size. The effective size is server-owned; an edit patches one task against the live overrides. */
export function TaskTiers({ tiers }: { tiers: readonly TaskTierRow[] }) {
  const actions = useSettingsActions();
  const admin = useIsAdmin();
  const [error, setError] = useState<{ task: string; message: string } | null>(null);
  const pending = actions.setTaskTier.isPending || actions.resetLeaf.isPending;

  const save = (task: string, tier: ReasoningTier | null) => {
    if (!admin || pending) return;
    setError(null);
    actions.setTaskTier.mutate({ task, tier }, {
      onError: (failure) => setError({ task, message: settingsRefusalText(failure) }),
    });
  };
  const resetDocument = () => {
    if (!admin || pending) return;
    setError(null);
    actions.resetLeaf.mutate({ leaf: 'agent.tasks' }, {
      onError: (failure) => setError({ task: tiers[0]?.task ?? '', message: settingsRefusalText(failure) }),
    });
  };

  return (
    <RowCard label="Size of each job">
      {tiers.map((row, index) => {
        const { task, name: label, tier, source } = row;
        return (
          <SettingRow
            key={task}
            setting={`task-tier-${task}`}
            label={label}
            htmlFor={`task-tier-${task}`}
            status={error?.task === task ? error.message : source === 'invalid' ? row.remedy : source === 'task-override' ? 'Changed for this task' : 'Declared size'}
            refused={error?.task === task}
            control={<div className="flex w-full items-center gap-s2">
              <Select
                id={`task-tier-${task}`}
                label={`${label} size`}
                value={tier ?? ''}
                placeholder={source === 'invalid' ? 'Choose a size' : undefined}
                disabled={!admin || pending || (source === 'invalid' && row.repair === 'reset-leaf')}
                options={REASONING_TIERS.map((option) => ({ value: option, label: SIZE_WORDS[option] ?? option }))}
                onValueChange={(option) => save(task, option as ReasoningTier)}
              />
              {source === 'invalid' && row.repair === 'reset-leaf' && index === 0 && admin && (
                <Button size="sm" aria-label="Reset task overrides" disabled={pending} onClick={resetDocument}>Reset</Button>
              )}
              {source !== 'task' && !(source === 'invalid' && row.repair === 'reset-leaf') && admin && (
                <Button size="sm" aria-label={`Reset ${label} size`} disabled={pending} onClick={() => save(task, null)}>Reset</Button>
              )}
            </div>}
          />
        );
      })}
    </RowCard>
  );
}
