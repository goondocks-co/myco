// @vitest-environment jsdom

import { renderHook, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { SETTINGS_GROUPS, type SettingField } from '../../packages/myco/ui/src/settings/manifest';

/* ---------- Substrate mocks ---------- */

const setFieldMock = vi.fn();
const updateGroveMutateMock = vi.fn();
const updateMachineMutateMock = vi.fn();

const projectState = {
  effective: {
    agent: { provider: { context_length: 4096 } },
    // release_provenance.* is the canonical project-tier example after the
    // 2026-06 scope correction (capture/notifications → machine, skills →
    // grove). The merged "effective" view still carries it for reads.
    release_provenance: { enabled: true },
  } as Record<string, unknown>,
  isLoading: false,
};

const groveState: {
  data: { groveId: string; config: Record<string, unknown> } | undefined;
  isLoading: boolean;
  error: unknown;
} = {
  data: {
    groveId: 'g1',
    config: {
      daemon: { stale_session_threshold_ms: 3_600_000 },
      maintenance: { auto_optimize_interval_hours: 10 },
      agent: { scheduled_tasks_active_window_days: 14 },
    },
  },
  isLoading: false,
  error: null,
};

const machineState: {
  data: { config: Record<string, unknown> } | undefined;
  isLoading: boolean;
  error: unknown;
} = {
  data: {
    config: {
      daemon: { log_level: 'info', log_retention_days: 30, update_channel: 'stable' },
    },
  },
  isLoading: false,
  error: null,
};

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: projectState.effective,
    local: {},
    isLoading: projectState.isLoading,
    isLocalOverride: () => false,
    setField: (...args: unknown[]) => setFieldMock(...args),
    setFields: vi.fn(),
    resetField: vi.fn(),
    promoteField: vi.fn(),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-grove-config', () => ({
  useGroveConfig: () => ({
    data: groveState.data,
    isLoading: groveState.isLoading,
    error: groveState.error,
  }),
  useUpdateGroveConfig: () => ({
    mutateAsync: (...args: unknown[]) => updateGroveMutateMock(...args),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-machine-config', () => ({
  useMachineConfig: () => ({
    data: machineState.data,
    isLoading: machineState.isLoading,
    error: machineState.error,
  }),
  useUpdateMachineConfig: () => ({
    mutateAsync: (...args: unknown[]) => updateMachineMutateMock(...args),
  }),
  useAddToMachineConfigList: () => ({ mutate: () => {} }),
  useRemoveFromMachineConfigList: () => ({ mutate: () => {} }),
}));

// Import the hook AFTER the mocks so module-level imports resolve to stubs.
const { useUnifiedSettings } = await import(
  '../../packages/myco/ui/src/hooks/use-unified-settings'
);

/* ---------- Fixtures ---------- */

function findField(key: string): SettingField {
  for (const group of SETTINGS_GROUPS) {
    for (const f of group.fields) {
      if (f.key === key) return f;
    }
  }
  throw new Error(`Test fixture: missing field for key ${key}`);
}

const PROJECT_FIELD = findField('release_provenance.enabled');
const GROVE_FIELD = findField('maintenance.auto_optimize_interval_hours');
const MACHINE_FIELD = findField('daemon.log_level');

describe('useUnifiedSettings', () => {
  beforeEach(() => {
    setFieldMock.mockReset();
    updateGroveMutateMock.mockReset();
    updateMachineMutateMock.mockReset();
    setFieldMock.mockResolvedValue(undefined);
    updateGroveMutateMock.mockResolvedValue(undefined);
    updateMachineMutateMock.mockResolvedValue(undefined);
    projectState.isLoading = false;
    groveState.isLoading = false;
    groveState.error = null;
    machineState.isLoading = false;
    machineState.error = null;
    groveState.data = {
      groveId: 'g1',
      config: {
        daemon: { stale_session_threshold_ms: 3_600_000 },
        maintenance: { auto_optimize_interval_hours: 10 },
        agent: { scheduled_tasks_active_window_days: 14 },
      },
    };
    machineState.data = {
      config: {
        daemon: { log_level: 'info', log_retention_days: 30, update_channel: 'stable' },
      },
    };
  });

  it('readField walks the right config for each scope', () => {
    const { result } = renderHook(() => useUnifiedSettings());
    expect(result.current.readField(PROJECT_FIELD)).toBe(true);
    expect(result.current.readField(GROVE_FIELD)).toBe(10);
    expect(result.current.readField(MACHINE_FIELD)).toBe('info');
  });

  it('readField returns undefined when a scope has no data yet', () => {
    groveState.data = undefined;
    machineState.data = undefined;
    const { result } = renderHook(() => useUnifiedSettings());
    expect(result.current.readField(GROVE_FIELD)).toBeUndefined();
    expect(result.current.readField(MACHINE_FIELD)).toBeUndefined();
    // Project still resolves because its effective view is loaded.
    expect(result.current.readField(PROJECT_FIELD)).toBe(true);
  });

  it('writeField(project) delegates to useScopedConfig.setField with project scope', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(PROJECT_FIELD, false);
    });
    expect(setFieldMock).toHaveBeenCalledWith(
      'release_provenance.enabled',
      false,
      'project',
    );
  });

  it('writeField(grove) builds a nested patch and calls the grove mutation', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(GROVE_FIELD, 30);
    });
    expect(updateGroveMutateMock).toHaveBeenCalledWith({
      patch: { maintenance: { auto_optimize_interval_hours: 30 } },
    });
  });

  it('writeField(machine) builds a nested patch and calls the machine mutation', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(MACHINE_FIELD, 'debug');
    });
    expect(updateMachineMutateMock).toHaveBeenCalledWith({
      patch: { daemon: { log_level: 'debug' } },
    });
  });

  it('writeField(grove) with undefined routes through the clear list', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(GROVE_FIELD, undefined);
    });
    expect(updateGroveMutateMock).toHaveBeenCalledWith({
      clear: ['maintenance.auto_optimize_interval_hours'],
    });
  });

  it('writeField(machine) with undefined routes through the clear list', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(MACHINE_FIELD, undefined);
    });
    expect(updateMachineMutateMock).toHaveBeenCalledWith({
      clear: ['daemon.log_level'],
    });
  });

  it('writeField(project) with undefined delegates a clear to setField', async () => {
    const { result } = renderHook(() => useUnifiedSettings());
    await act(async () => {
      await result.current.writeField(PROJECT_FIELD, undefined);
    });
    expect(setFieldMock).toHaveBeenCalledWith(
      'release_provenance.enabled',
      undefined,
      'project',
    );
  });

  it('isLoading aggregates across scopes', () => {
    groveState.isLoading = true;
    const { result } = renderHook(() => useUnifiedSettings());
    expect(result.current.isLoading).toBe(true);
  });

  it('error surfaces the first non-null substrate error', () => {
    const groveErr = new Error('grove down');
    groveState.error = groveErr;
    const { result } = renderHook(() => useUnifiedSettings());
    expect(result.current.error).toBe(groveErr);
  });

  it('scopeCounts matches the renderable manifest fields (excludes customRender:card-owns)', () => {
    // customRender:'card-owns' entries are present in the manifest for sync
    // test coverage but never render as standalone rows — they shouldn't
    // inflate the filter-bar counters.
    const expected = { project: 0, grove: 0, machine: 0 } as Record<
      'project' | 'grove' | 'machine',
      number
    >;
    for (const group of SETTINGS_GROUPS) {
      for (const f of group.fields) {
        if (f.customRender === 'card-owns') continue;
        expected[f.scope] += 1;
      }
    }
    const { result } = renderHook(() => useUnifiedSettings());
    expect(result.current.scopeCounts).toEqual(expected);
    // After the 2026-06 scope correction every project-scoped manifest entry
    // is owned by a custom card (release_provenance.*), so the renderable
    // project-row count is legitimately 0. Grove and machine still surface
    // standalone rows.
    expect(expected.grove).toBeGreaterThan(0);
    expect(expected.machine).toBeGreaterThan(0);
  });
});
