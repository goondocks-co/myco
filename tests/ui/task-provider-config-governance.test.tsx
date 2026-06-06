// @vitest-environment jsdom
/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';

let capabilityEnabled = false;
let serverEffectiveScheduleEnabled = false;

const taskConfig = { schedule: { enabled: true } };
const providerDraft = {
  harness: 'claude-sdk',
  type: 'openai',
  localBackend: undefined,
  model: '',
  reasoningLow: '',
  reasoningDefault: '',
  reasoningHigh: '',
  baseUrl: '',
  contextLength: '',
};
const providersData = { providers: [] };
const modelsData = { models: [] };
const taskConfigResponse = {
  taskId: 'vault-evolve',
  config: taskConfig,
  capability: 'vault_evolution',
  get capabilityEnabled() {
    return capabilityEnabled;
  },
  get effectiveScheduleEnabled() {
    return serverEffectiveScheduleEnabled;
  },
};
const taskConfigQueryResult = { data: taskConfigResponse };

mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  defaultBaseUrlForProvider: () => '',
  maybeInferHarnessFromProviderType: () => 'claude-sdk',
  REASONING_LEVELS: ['low', 'default', 'high'],
  useProviders: () => ({ data: providersData, isPending: false }),
  useTaskConfig: () => taskConfigQueryResult,
  useTestProvider: () => ({
    isPending: false,
    isSuccess: false,
    data: undefined,
    mutate: () => {},
    reset: () => {},
  }),
  useUpdateTaskConfig: () => ({
    isPending: false,
    mutate: () => {},
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-models', () => ({
  useModels: () => ({ data: modelsData }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({ type: 'openai' }),
  providerDraftFromSource: () => providerDraft,
  useProviderConfigDraft: () => ({
    draft: providerDraft,
    isDirty: false,
    commitDraft: () => {},
    handleHarnessChange: () => {},
    handleProviderChange: () => {},
    handleModelChange: () => {},
    handleLocalBackendChange: () => {},
    handleReasoningChange: () => {},
    handleBaseUrlChange: () => {},
    handleContextLengthChange: () => {},
  }),
}));

mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => <div data-testid="provider-model-selector" />,
}));

mock.module('../../packages/myco/ui/src/components/providers/AdvancedModelPin', () => ({
  AdvancedModelPin: () => <div data-testid="advanced-model-pin" />,
}));

mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => <div data-testid="reasoning-profiles" />,
}));

import { TaskProviderConfig } from '../../packages/myco/ui/src/components/agent/TaskProviderConfig';

function renderScheduledTask() {
  return render(
    <TaskProviderConfig
      taskId="vault-evolve"
      defaults={{ harness: 'claude-sdk', providerType: 'openai' }}
      schedule={{ enabled: true, intervalSeconds: 300, runIn: ['active'] }}
    />,
  );
}

describe('TaskProviderConfig capability governance', () => {
  it('disables schedule controls when the governing capability is off', () => {
    capabilityEnabled = false;
    serverEffectiveScheduleEnabled = false;

    renderScheduledTask();

    expect(screen.getByText('governed off')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByLabelText('Run every (seconds)')).toBeNull();
  });

  it('keeps schedule controls editable when the governing capability is on', () => {
    capabilityEnabled = true;
    serverEffectiveScheduleEnabled = true;

    renderScheduledTask();

    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'true');
  });

  it('uses the API effective schedule state when no local draft is pending', () => {
    capabilityEnabled = true;
    serverEffectiveScheduleEnabled = false;

    renderScheduledTask();

    expect(screen.getByText('off')).toBeInTheDocument();
    expect(screen.getByRole('switch')).not.toBeDisabled();
    expect(screen.getByRole('switch')).toHaveAttribute('aria-checked', 'false');
  });
});
