// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ScopedField } from '../../packages/myco/ui/src/components/config/ScopedField';
import type { MycoConfig } from '../../packages/myco/ui/src/hooks/use-config';

const useScopedConfigMock = vi.fn();

vi.mock('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => useScopedConfigMock(),
}));

vi.mock('../../packages/myco/ui/src/components/config/restart-gate', () => ({
  useMarkRestartDirty: () => vi.fn(),
}));

const baseConfig: MycoConfig = {
  version: 3,
  config_version: 5,
  embedding: {
    provider: 'ollama',
    model: 'bge-m3',
  },
  daemon: {
    port: null,
    log_level: 'info',
    log_retention_days: 30,
  },
  maintenance: {
    auto_optimize: true,
    auto_optimize_interval_hours: 24,
  },
  capture: {
    transcript_paths: [],
    plan_dirs: [],
    artifact_extensions: ['md'],
    buffer_max_events: 1000,
    ignore_plan_dirs_in_git: false,
  },
  agent: {
    summary_batch_interval: 5,
  },
  context: {
    digest_tier: 5000,
    prompt_search: true,
    prompt_max_spores: 3,
  },
  backup: {},
  appearance: {
    theme: 'sage',
    mode: 'dark',
    font: 'default',
    density: 'normal',
  },
  notifications: {
    enabled: true,
    system_notifications: false,
    default_mode: 'summary',
    domains: {
      settings: {
        enabled: true,
        mode: 'banner',
      },
    },
  },
};

describe('ScopedField scope badges', () => {
  beforeEach(() => {
    useScopedConfigMock.mockReturnValue({
      effective: baseConfig,
      local: {},
      setField: vi.fn().mockResolvedValue(undefined),
      resetField: vi.fn().mockResolvedValue(undefined),
      promoteField: vi.fn().mockResolvedValue(undefined),
    });
  });

  it('shows a project badge when a field has no local override', () => {
    render(
      <ScopedField path="context.prompt_search" label="Prompt Search" defaultScope="project">
        {() => <div>control</div>}
      </ScopedField>,
    );

    expect(screen.getByText('Project')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Personal' })).not.toBeInTheDocument();
  });

  it('shows the personal pill when a field has a local override', () => {
    useScopedConfigMock.mockReturnValue({
      effective: {
        ...baseConfig,
        context: {
          prompt_search: false,
        },
      },
      local: {
        context: {
          prompt_search: false,
        },
      },
      setField: vi.fn().mockResolvedValue(undefined),
      resetField: vi.fn().mockResolvedValue(undefined),
      promoteField: vi.fn().mockResolvedValue(undefined),
    });

    render(
      <ScopedField path="context.prompt_search" label="Prompt Search" defaultScope="project">
        {() => <div>control</div>}
      </ScopedField>,
    );

    expect(screen.getByRole('button', { name: 'Personal' })).toBeInTheDocument();
  });
});
