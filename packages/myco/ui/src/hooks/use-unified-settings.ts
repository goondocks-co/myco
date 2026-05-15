import { useCallback, useMemo } from 'react';
import { getAtPath, setAtPath } from '@myco/utils/dot-path';
import {
  SETTINGS_GROUPS,
  type SettingField,
  type SettingScope,
} from '../settings/manifest';
import { useScopedConfig } from './use-scoped-config';
import { useGroveConfig, useUpdateGroveConfig } from './use-grove-config';
import { useMachineConfig, useUpdateMachineConfig } from './use-machine-config';
import type { ConfigPath } from '../lib/config-paths';
import type { GroveConfig, MachineConfig } from '@myco/config/schema';
import type { MachineConfigPatch } from './use-machine-config';

export interface UnifiedSettings {
  /** Read the current value for a field, or undefined if not yet loaded. */
  readField: (field: SettingField) => unknown;
  /** Write a new value. Resolves when the write hits the daemon. */
  writeField: (field: SettingField, value: unknown) => Promise<void>;
  /** Aggregate loading across scopes. */
  isLoading: boolean;
  /** Aggregate error across scopes; first non-null wins. */
  error: unknown | null;
  /** Field counts per scope (derived from the loaded manifest). */
  scopeCounts: Record<SettingScope, number>;
}

/**
 * Single read/write surface for the unified `/settings` page. Delegates each
 * `SettingField` to its substrate hook based on `field.scope`:
 *
 * - `project` → `useScopedConfig().setField(path, value, 'project')` and the
 *   `effective` merged view for reads. Personal-overlay UX (the `local`
 *   scope) is intentionally NOT surfaced here — Phase 5 writes only to the
 *   canonical scopes, and the existing per-field "personal" toggle remains
 *   a separate flow.
 * - `grove` → `useGroveConfig()` for reads, `useUpdateGroveConfig()` for
 *   writes (patch object shaped to the dotted path).
 * - `machine` → `useMachineConfig()` for reads, `useUpdateMachineConfig()`
 *   for writes (patch object shaped to the dotted path).
 *
 * `readField` returns `undefined` when the underlying scope hasn't loaded
 * yet so callers can render a placeholder without crashing. `scopeCounts`
 * is computed once from the static manifest and powers the filter-bar
 * counters on the page.
 */
export function useUnifiedSettings(): UnifiedSettings {
  const project = useScopedConfig();
  const grove = useGroveConfig();
  const machine = useMachineConfig();
  const updateGrove = useUpdateGroveConfig();
  const updateMachine = useUpdateMachineConfig();

  const groveConfig: GroveConfig | undefined = grove.data?.config;
  const machineConfig: MachineConfig | undefined = machine.data?.config;

  const readField = useCallback(
    (field: SettingField): unknown => {
      switch (field.scope) {
        case 'project': {
          const effective = project.effective as unknown;
          if (effective === undefined || effective === null) return undefined;
          return getAtPath(effective as Record<string, unknown>, field.key);
        }
        case 'grove': {
          if (!groveConfig) return undefined;
          return getAtPath(groveConfig as unknown as Record<string, unknown>, field.key);
        }
        case 'machine': {
          if (!machineConfig) return undefined;
          return getAtPath(machineConfig as unknown as Record<string, unknown>, field.key);
        }
      }
    },
    [project.effective, groveConfig, machineConfig],
  );

  const writeField = useCallback(
    async (field: SettingField, value: unknown): Promise<void> => {
      switch (field.scope) {
        case 'project': {
          await project.setField(field.key as ConfigPath, value, 'project');
          return;
        }
        case 'grove': {
          const patch: Record<string, unknown> = {};
          setAtPath(patch, field.key, value);
          await updateGrove.mutateAsync(patch as Partial<GroveConfig>);
          return;
        }
        case 'machine': {
          const patch: Record<string, unknown> = {};
          setAtPath(patch, field.key, value);
          await updateMachine.mutateAsync(patch as MachineConfigPatch);
          return;
        }
      }
    },
    [project, updateGrove, updateMachine],
  );

  const isLoading =
    project.isLoading || Boolean(grove.isLoading) || Boolean(machine.isLoading);

  const error: unknown =
    (grove.error as unknown) ?? (machine.error as unknown) ?? null;

  const scopeCounts = useMemo<Record<SettingScope, number>>(() => {
    const counts: Record<SettingScope, number> = { project: 0, grove: 0, machine: 0 };
    for (const group of SETTINGS_GROUPS) {
      for (const f of group.fields) {
        // Manifest entries owned by a custom card aren't user-visible as
        // standalone rows, so they don't belong in the filter-bar counts.
        if (f.customRender === 'card-owns') continue;
        counts[f.scope] += 1;
      }
    }
    return counts;
  }, []);

  return { readField, writeField, isLoading, error, scopeCounts };
}
