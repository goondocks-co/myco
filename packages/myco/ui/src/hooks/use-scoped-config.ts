import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef } from 'react';
import {
  fetchMergedConfig,
  fetchLocalConfig,
  writeScopedConfig,
  clearLocalConfigKeys,
  putJson,
} from '../lib/api';
import { getAtPath, setAtPath } from '@myco/utils/dot-path';
import type { MycoConfig } from './use-config';
import type { GroveConfig, MachineConfig } from '@myco/config/schema';
import type { ConfigPath } from '../lib/config-paths';
import { useUpdateGroveConfig } from './use-grove-config';
import { useUpdateMachineConfig, type MachineConfigPatch } from './use-machine-config';
import { useActiveProjectSelection } from './use-project-selection';
import { requestContextHeadersForSelection, selectionKey, type ProjectSelection } from '../lib/selection';

export type Scope = 'project' | 'local' | 'grove' | 'machine';

const MERGED_KEY = ['config', 'merged'] as const;
const LOCAL_KEY = ['config', 'local'] as const;
const NOTIFICATIONS_KEY = ['notifications'] as const;

/**
 * Scoped config hook for field-level settings writes targeting an explicit
 * project selection. The public `useScopedConfig()` is implemented as
 * `useScopedConfigForSelection(useActiveProjectSelection())` so that the
 * Groves capability panel can target an arbitrary project without
 * duplicating the query/write logic.
 *
 * - `effective` is the merged view used for display.
 * - `local` is the raw local overlay; a key present here means that path is
 *   personal-scoped on this machine.
 * - `setField` writes a single field into the chosen scope by constructing
 *   a nested patch that matches the dotted path.
 * - `resetField` clears a local override so the project value shines through.
 *
 * Returned callbacks are stable across re-renders (data is read through refs)
 * so consumers don't have their `useCallback` deps thrash on every refetch.
 */
export function useScopedConfigForSelection(selection: ProjectSelection | null) {
  const qc = useQueryClient();
  const updateGroveConfig = useUpdateGroveConfig();
  const updateMachineConfig = useUpdateMachineConfig();
  const activeSelectionKey = selection ? selectionKey(selection) : 'none';
  const contextHeaders = useMemo(
    () => requestContextHeadersForSelection(selection),
    // Stable on grove + project identity; avoids thrash when the selection
    // object reference changes but the underlying ids stay the same.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selection?.grove.id, selection?.project.project_id],
  );

  const merged = useQuery({
    queryKey: [...MERGED_KEY, activeSelectionKey],
    queryFn: ({ signal }) => fetchMergedConfig(signal, contextHeaders),
  });
  const local = useQuery({
    queryKey: [...LOCAL_KEY, activeSelectionKey],
    queryFn: ({ signal }) => fetchLocalConfig(signal, contextHeaders),
  });

  const mergedRef = useRef(merged.data);
  mergedRef.current = merged.data;
  const localRef = useRef(local.data);
  localRef.current = local.data;

  // Local writes only need the local query refetched; project writes need both
  // (because merged = project + local). Splitting saves a network round-trip
  // per personal-default toggle, which is the common case.
  const invalidateNotifications = useCallback(() => {
    void qc.invalidateQueries({ queryKey: NOTIFICATIONS_KEY });
  }, [qc]);
  const invalidateLocal = useCallback(() => {
    void qc.invalidateQueries({ queryKey: LOCAL_KEY });
    void qc.invalidateQueries({ queryKey: MERGED_KEY });
    invalidateNotifications();
  }, [invalidateNotifications, qc]);
  const invalidateProject = useCallback(() => {
    void qc.invalidateQueries({ queryKey: MERGED_KEY });
    invalidateNotifications();
  }, [invalidateNotifications, qc]);
  const invalidateForScope = useCallback(
    (scope: Scope) => {
      if (scope === 'local') return invalidateLocal();
      return invalidateProject();
    },
    [invalidateLocal, invalidateProject],
  );

  const setField = useCallback(
    async <T,>(path: ConfigPath, value: T, scope: Scope): Promise<void> => {
      // `undefined` means "clear this field" — every tier PUT accepts a
      // `clear` list, so empty-string commits route through it instead of
      // the dead-end conventions (undefined vanishes from JSON → 400
      // "patch or clear required"; explicit null fails Zod validation).
      if (value === undefined) {
        if (scope === 'grove') {
          await updateGroveConfig.mutateAsync({ clear: [path] });
          invalidateNotifications();
        } else if (scope === 'machine') {
          await updateMachineConfig.mutateAsync({ clear: [path] });
          invalidateNotifications();
        } else {
          await writeScopedConfig(scope, {}, [path], contextHeaders);
          invalidateForScope(scope);
        }
        return;
      }
      const patch: Record<string, unknown> = {};
      setAtPath(patch, path, value);
      if (scope === 'grove') {
        await updateGroveConfig.mutateAsync({ patch: patch as Partial<GroveConfig> });
        invalidateNotifications();
      } else if (scope === 'machine') {
        await updateMachineConfig.mutateAsync({ patch: patch as MachineConfigPatch });
        invalidateNotifications();
      } else {
        await writeScopedConfig(scope, patch, undefined, contextHeaders);
        invalidateForScope(scope);
      }
    },
    [contextHeaders, invalidateForScope, invalidateNotifications, updateGroveConfig, updateMachineConfig],
  );

  /**
   * Atomic write to the chosen scope. Applies a patch (field -> value pairs)
   * and optionally clears a set of dot-paths — both in a single PUT so
   * coupled transitions can't tear (e.g. Clear Provider unsets the provider
   * and disables the tied task toggles together). Fields whose value is
   * `undefined` are treated as clears (same convention as `setField`).
   * Every tier PUT (scoped, grove, machine) accepts the clear list.
   */
  const setFields = useCallback(
    async (
      fields: Array<{ path: ConfigPath; value: unknown }>,
      scope: Scope,
      clearPaths?: ConfigPath[],
    ): Promise<void> => {
      const patch: Record<string, unknown> = {};
      const clears: string[] = [...(clearPaths ?? [])];
      for (const { path, value } of fields) {
        if (value === undefined) clears.push(path);
        else setAtPath(patch, path, value);
      }
      if (scope === 'grove') {
        await updateGroveConfig.mutateAsync({
          patch: patch as Partial<GroveConfig>,
          clear: clears.length > 0 ? clears : undefined,
        });
        invalidateNotifications();
      } else if (scope === 'machine') {
        await updateMachineConfig.mutateAsync({
          patch: patch as MachineConfigPatch,
          clear: clears.length > 0 ? clears : undefined,
        });
        invalidateNotifications();
      } else {
        await writeScopedConfig(scope, patch, clears.length > 0 ? clears : undefined, contextHeaders);
        invalidateForScope(scope);
      }
    },
    [contextHeaders, invalidateForScope, invalidateNotifications, updateGroveConfig, updateMachineConfig],
  );

  const resetField = useCallback(async (path: ConfigPath): Promise<void> => {
    await clearLocalConfigKeys([path], contextHeaders);
    invalidateLocal();
  }, [contextHeaders, invalidateLocal]);

  const resetFields = useCallback(async (paths: ConfigPath[]): Promise<void> => {
    if (paths.length === 0) return;
    await clearLocalConfigKeys(paths as string[], contextHeaders);
    invalidateLocal();
  }, [contextHeaders, invalidateLocal]);

  const isLocalOverride = useCallback(
    (path: ConfigPath): boolean =>
      getAtPath((localRef.current ?? {}) as Record<string, unknown>, path) !== undefined,
    [],
  );

  /**
   * Add a value to a list-valued config field. For machine scope, uses the
   * server-side addToList op (race-free read-modify-write). For other scopes,
   * falls back to a full-array setField after reading current effective value
   * — clients should prefer machine scope for the critical paths.
   */
  const addToConfigList = useCallback(
    async (path: ConfigPath, value: string, scope: Scope): Promise<void> => {
      if (scope === 'machine') {
        const config = await putJson<MachineConfig>('/machine-config', {
          addToList: [{ path, values: [value] }],
        });
        qc.setQueryData(['machine-config'], { config });
        void qc.invalidateQueries({ queryKey: ['config', 'merged'] });
        return;
      }
      // Fallback: read current array from merged config and append.
      const current = getAtPath((mergedRef.current ?? {}) as Record<string, unknown>, path);
      const arr = Array.isArray(current) ? current as string[] : [];
      if (!arr.includes(value)) {
        await setField(path, [...arr, value] as unknown as string, scope);
      }
    },
    // putJson is a stable module-level import; not needed in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, setField],
  );

  /**
   * Remove a value from a list-valued config field. For machine scope, uses
   * the server-side removeFromList op (race-free). Fallback for other scopes
   * reads current effective array and filters.
   */
  const removeFromConfigList = useCallback(
    async (path: ConfigPath, value: string, scope: Scope): Promise<void> => {
      if (scope === 'machine') {
        const config = await putJson<MachineConfig>('/machine-config', {
          removeFromList: [{ path, values: [value] }],
        });
        qc.setQueryData(['machine-config'], { config });
        void qc.invalidateQueries({ queryKey: ['config', 'merged'] });
        return;
      }
      const current = getAtPath((mergedRef.current ?? {}) as Record<string, unknown>, path);
      const arr = Array.isArray(current) ? current as string[] : [];
      await setField(path, arr.filter((v) => v !== value) as unknown as string, scope);
    },
    // putJson is a stable module-level import; not needed in deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [qc, setField],
  );

  return {
    effective: merged.data as MycoConfig | undefined,
    local: (local.data ?? {}) as Partial<MycoConfig>,
    isLoading: merged.isLoading || local.isLoading,
    isLocalOverride,
    setField,
    setFields,
    resetField,
    resetFields,
    addToConfigList,
    removeFromConfigList,
  };
}

/** Scoped config hook for the active route selection (the common case). */
export function useScopedConfig() {
  return useScopedConfigForSelection(useActiveProjectSelection());
}
