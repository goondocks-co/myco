import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useRef, type ReactNode } from 'react';
import {
  fetchMergedConfig,
  fetchLocalConfig,
  writeScopedConfig,
  clearLocalConfigKeys,
  putJson,
  fetchJson,
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

// ---------------------------------------------------------------------------
// Team target — binds every `useScopedConfig()` in its subtree to a served
// grove reached through the team routes (server-mode design spec §6) instead
// of the ambient project selection. Mounted once by `TeamSettingsPanel`
// around the SAME reused form components (`AgentProviderCard`, `ScopedField`
// fields, etc.) — those components are unmodified; they read a different
// target through this same hook surface, never a fork.
// ---------------------------------------------------------------------------

export interface TeamConfigTarget {
  /**
   * The DESTINATION HOST for a team-write from a MEMBER machine (E1 §5.3):
   * the daemon resolves `x-myco-host-id` into a synthetic routing target
   * built from the host record — which is what makes a joined host with
   * ZERO attached projects configurable (there is no attach ref to carry
   * the write on such a host, so resolving from the host id is the only
   * thing that reaches it). `null` targets THIS machine's own
   * served grove directly — no carrier needed, resolved server-side from
   * `hostServe.servedGroveId` — used when configuring a Team from the host
   * machine itself.
   */
  carrier: { hostId: string } | null;
}

const TeamConfigTargetContext = createContext<TeamConfigTarget | null>(null);

/** Wrap the reused settings forms with this to bind them to a served grove
 *  via the team routes instead of the ambient project selection. */
export function TeamConfigTargetProvider({
  target,
  children,
}: {
  target: TeamConfigTarget;
  children: ReactNode;
}) {
  return (
    <TeamConfigTargetContext.Provider value={target}>{children}</TeamConfigTargetContext.Provider>
  );
}

/** The nearest team target, or `null` outside any `TeamConfigTargetProvider`. */
export function useTeamConfigTargetOrNull(): TeamConfigTarget | null {
  return useContext(TeamConfigTargetContext);
}

/** True when `useScopedConfig()` in this subtree is bound to a served grove
 *  rather than the ambient project selection. Drives the "Team" badge and
 *  suppressed Personal opt-in in `ScopePill`/`ScopedField`. */
export function useIsTeamConfigTarget(): boolean {
  return useTeamConfigTargetOrNull() !== null;
}

/** Explicit request-context headers for a team target. A `null` carrier
 *  sends explicit EMPTY grove/project headers (not simply omitted) so they
 *  override whatever ambient project-selection headers `fetchJson` would
 *  otherwise attach — omitting them would let the last-browsed project
 *  silently carry through and mis-route the request to the wrong host. */
export function teamCarrierHeaders(target: TeamConfigTarget): Record<string, string> {
  return target.carrier
    ? {
      'x-myco-host-id': target.carrier.hostId,
      // Explicit-empty grove/project ALSO ride along: they override whatever
      // ambient project-selection headers fetchJson would attach, so the
      // host-id branch at the server chokepoint is never shadowed by a
      // stale ambient project that happens to be attached elsewhere.
      'x-myco-grove-id': '',
      'x-myco-project-id': '',
    }
    : { 'x-myco-grove-id': '', 'x-myco-project-id': '' };
}

const TEAM_CONFIG_KEY = ['team-config'] as const;

interface TeamConfigResponse {
  groveId: string;
  config: Record<string, unknown>;
  keyHealth: 'ok' | 'missing_key';
}

function teamTargetQueryKeyPart(target: TeamConfigTarget | null): string {
  return target?.carrier ? target.carrier.hostId : 'self';
}

/**
 * Team-target counterpart to `useScopedConfigForSelection` — the SAME public
 * shape (so `AgentProviderCard`, `EmbeddingCard`, and `ScopedField` work
 * completely unmodified) but every read/write goes through Task 8's
 * `/api/team/...` routes instead of the project-scoped config endpoints.
 * Personal (`local`) scope never applies to a served grove (grove-homed
 * personal overrides are refused by design — spec §6): `local` is rejected
 * loudly rather than silently no-opped, and `resetField`/`resetFields` are
 * no-ops (there is nothing to reset — `ScopePill` never offers the action
 * in team mode in the first place).
 */
function useTeamConfig(enabled: boolean) {
  const target = useTeamConfigTargetOrNull();
  const qc = useQueryClient();
  const keyPart = teamTargetQueryKeyPart(target);
  // Memoized on the carrier identity (not the target object reference) so
  // setField/setFields stay stable across re-renders — matching
  // useScopedConfigForSelection's contextHeaders pattern below.
  const headers = useMemo(
    () => (target ? teamCarrierHeaders(target) : {}),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target?.carrier?.hostId],
  );

  const query = useQuery({
    queryKey: [...TEAM_CONFIG_KEY, keyPart],
    queryFn: ({ signal }) => fetchJson<TeamConfigResponse>('/team/config', { signal, headers }),
    enabled,
  });

  const invalidate = useCallback(() => {
    void qc.invalidateQueries({ queryKey: TEAM_CONFIG_KEY });
  }, [qc]);

  const setField = useCallback(
    async <T,>(path: ConfigPath, value: T, scope: Scope): Promise<void> => {
      if (scope === 'local') {
        throw new Error('Personal overrides are not available for team settings.');
      }
      if (value === undefined) {
        await putJson('/team/config', { clear: [path] }, { headers });
      } else {
        const patch: Record<string, unknown> = {};
        setAtPath(patch, path, value);
        await putJson('/team/config', { patch }, { headers });
      }
      invalidate();
    },
    [headers, invalidate],
  );

  const setFields = useCallback(
    async (
      fields: Array<{ path: ConfigPath; value: unknown }>,
      scope: Scope,
      clearPaths?: ConfigPath[],
    ): Promise<void> => {
      if (scope === 'local') {
        throw new Error('Personal overrides are not available for team settings.');
      }
      const patch: Record<string, unknown> = {};
      const clears: string[] = [...(clearPaths ?? [])];
      for (const { path, value } of fields) {
        if (value === undefined) clears.push(path);
        else setAtPath(patch, path, value);
      }
      await putJson('/team/config', { patch, clear: clears.length > 0 ? clears : undefined }, { headers });
      invalidate();
    },
    [headers, invalidate],
  );

  const resetField = useCallback(async (_path: ConfigPath): Promise<void> => {}, []);
  const resetFields = useCallback(async (_paths: ConfigPath[]): Promise<void> => {}, []);
  const isLocalOverride = useCallback((): boolean => false, []);

  const effective = query.data?.config as MycoConfig | undefined;

  const addToConfigList = useCallback(
    async (path: ConfigPath, value: string, scope: Scope): Promise<void> => {
      const current = getAtPath((effective ?? {}) as Record<string, unknown>, path);
      const arr = Array.isArray(current) ? (current as string[]) : [];
      if (!arr.includes(value)) await setField(path, [...arr, value] as unknown as string, scope);
    },
    [effective, setField],
  );

  const removeFromConfigList = useCallback(
    async (path: ConfigPath, value: string, scope: Scope): Promise<void> => {
      const current = getAtPath((effective ?? {}) as Record<string, unknown>, path);
      const arr = Array.isArray(current) ? (current as string[]) : [];
      await setField(path, arr.filter((v) => v !== value) as unknown as string, scope);
    },
    [effective, setField],
  );

  return {
    effective,
    local: {} as Partial<MycoConfig>,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error as Error | null,
    isLocalOverride,
    setField,
    setFields,
    resetField,
    resetFields,
    addToConfigList,
    removeFromConfigList,
    keyHealth: query.data?.keyHealth,
  };
}

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
export function useScopedConfigForSelection(selection: ProjectSelection | null, enabled = true) {
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
    enabled,
  });
  const local = useQuery({
    queryKey: [...LOCAL_KEY, activeSelectionKey],
    queryFn: ({ signal }) => fetchLocalConfig(signal, contextHeaders),
    enabled,
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
    isError: merged.isError || local.isError,
    error: (merged.error ?? local.error) as Error | null,
    isLocalOverride,
    setField,
    setFields,
    resetField,
    resetFields,
    addToConfigList,
    removeFromConfigList,
    keyHealth: undefined as 'ok' | 'missing_key' | undefined,
  };
}

/**
 * Scoped config hook for the active route selection (the common case) — OR,
 * inside a `TeamConfigTargetProvider`, the bound served grove via the team
 * routes. Both branches always run (React Query `enabled` gates the actual
 * fetch) so the hook order stays identical regardless of which target is
 * active — a component never conditionally calls a different hook shape.
 */
export function useScopedConfig() {
  const isTeam = useIsTeamConfigTarget();
  const projectResult = useScopedConfigForSelection(useActiveProjectSelection(), !isTeam);
  const teamResult = useTeamConfig(isTeam);
  return isTeam ? teamResult : projectResult;
}
