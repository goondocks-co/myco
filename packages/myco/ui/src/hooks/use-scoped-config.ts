import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import {
  fetchMergedConfig,
  fetchLocalConfig,
  writeScopedConfig,
  clearLocalConfigKeys,
} from '../lib/api';
import { getAtPath, setAtPath } from '@myco/utils/dot-path';
import type { MycoConfig } from './use-config';
import type { ConfigPath } from '../lib/config-paths';
import { useUpdateGroveConfig } from './use-grove-config';

export type Scope = 'project' | 'local' | 'grove';

const MERGED_KEY = ['config', 'merged'] as const;
const LOCAL_KEY = ['config', 'local'] as const;
const NOTIFICATIONS_KEY = ['notifications'] as const;

/**
 * Scoped config hook — generalizes the Appearance provider pattern so any
 * dotted path in MycoConfig can be read from the merged (project + local)
 * view and written to either scope.
 *
 * - `effective` is the merged view used for display.
 * - `local` is the raw local overlay; a key present here means that path is
 *   personal-scoped on this machine.
 * - `setField` writes a single field into the chosen scope by constructing
 *   a nested patch that matches the dotted path.
 * - `resetField` clears a local override so the project value shines through.
 * - `promoteField` copies the current effective value into the project
 *   config, then clears the local override — equivalent to "this was working
 *   for me, make it the team default."
 *
 * Returned callbacks are stable across re-renders (data is read through refs)
 * so consumers don't have their `useCallback` deps thrash on every refetch.
 */
export function useScopedConfig() {
  const qc = useQueryClient();
  const updateGroveConfig = useUpdateGroveConfig();

  const merged = useQuery({
    queryKey: MERGED_KEY,
    queryFn: ({ signal }) => fetchMergedConfig(signal),
  });
  const local = useQuery({
    queryKey: LOCAL_KEY,
    queryFn: ({ signal }) => fetchLocalConfig(signal),
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
      const patch: Record<string, unknown> = {};
      setAtPath(patch, path, value);
      if (scope === 'grove') {
        await updateGroveConfig.mutateAsync(patch as Parameters<typeof updateGroveConfig.mutateAsync>[0]);
        invalidateNotifications();
      } else {
        await writeScopedConfig(scope, patch);
        invalidateForScope(scope);
      }
    },
    [invalidateForScope, invalidateNotifications, updateGroveConfig],
  );

  /**
   * Atomic write to the chosen scope. Applies a patch (field -> value pairs)
   * and optionally clears a set of dot-paths — both in a single PUT so
   * coupled transitions can't tear (e.g. Clear Provider unsets the provider
   * and disables the tied task toggles together).
   *
   * For grove scope, `clearPaths` is not supported (Grove config has no
   * local-override layer to clear); any provided clear paths are ignored.
   */
  const setFields = useCallback(
    async (
      fields: Array<{ path: ConfigPath; value: unknown }>,
      scope: Scope,
      clearPaths?: ConfigPath[],
    ): Promise<void> => {
      const patch: Record<string, unknown> = {};
      for (const { path, value } of fields) {
        setAtPath(patch, path, value);
      }
      if (scope === 'grove') {
        await updateGroveConfig.mutateAsync(patch as Parameters<typeof updateGroveConfig.mutateAsync>[0]);
        invalidateNotifications();
      } else {
        await writeScopedConfig(scope, patch, clearPaths as string[] | undefined);
        invalidateForScope(scope);
      }
    },
    [invalidateForScope, invalidateNotifications, updateGroveConfig],
  );

  const resetField = useCallback(async (path: ConfigPath): Promise<void> => {
    await clearLocalConfigKeys([path]);
    invalidateLocal();
  }, [invalidateLocal]);

  const promoteField = useCallback(async (path: ConfigPath): Promise<void> => {
    const value = getAtPath((mergedRef.current ?? {}) as Record<string, unknown>, path);
    const patch: Record<string, unknown> = {};
    setAtPath(patch, path, value);
    await writeScopedConfig('project', patch);
    await clearLocalConfigKeys([path]);
    invalidateLocal();
  }, [invalidateLocal]);

  const isLocalOverride = useCallback(
    (path: ConfigPath): boolean =>
      getAtPath((localRef.current ?? {}) as Record<string, unknown>, path) !== undefined,
    [],
  );

  return {
    effective: merged.data as MycoConfig | undefined,
    local: (local.data ?? {}) as Partial<MycoConfig>,
    isLoading: merged.isLoading || local.isLoading,
    isLocalOverride,
    setField,
    setFields,
    resetField,
    promoteField,
  };
}
