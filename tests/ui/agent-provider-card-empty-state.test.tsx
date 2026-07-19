// @vitest-environment jsdom

/**
 * AgentProviderCard empty state (Team Host E-4 W2 Task T6c). When no provider
 * is configured (`draft.type === ''`), the card promotes its "configure a
 * provider" hint into the codebase's consistent bordered empty-state callout
 * rather than a bare inline sentence. Heavy provider-UI internals are stubbed;
 * this test only asserts the empty-state treatment renders.
 */
import { describe, expect, it, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { vi } from '../helpers/vi-shim.js';

mock.module('../../packages/myco/ui/src/hooks/use-scoped-config', () => ({
  useScopedConfig: () => ({
    effective: { agent: {} },
    setFields: vi.fn(),
    isLocalOverride: () => false,
    resetFields: vi.fn(),
  }),
  useIsTeamConfigTarget: () => false,
}));

mock.module('../../packages/myco/ui/src/hooks/use-providers', () => ({
  useProviders: () => ({ data: { providers: [] }, isPending: false }),
  useTestProvider: () => ({ mutate: vi.fn(), reset: vi.fn(), isPending: false, isSuccess: false, isError: false }),
  defaultBaseUrlForProvider: () => '',
  maybeInferHarnessFromProviderType: () => 'claude-sdk',
  REASONING_LEVELS: ['low', 'default', 'high'],
}));

const emptyDraft = {
  type: '', harness: '', model: '', localBackend: '', baseUrl: '',
  contextLength: undefined, reasoningLow: '', reasoningDefault: '', reasoningHigh: '',
};

mock.module('../../packages/myco/ui/src/hooks/use-provider-config-draft', () => ({
  draftToNormalizedProviderConfig: () => ({ type: '' }),
  useProviderConfigDraft: () => ({
    draft: emptyDraft,
    savedDraft: emptyDraft,
    isDirty: false,
    clearDraft: vi.fn(),
    resetDraft: vi.fn(),
    handleHarnessChange: vi.fn(),
    handleProviderChange: vi.fn(),
    handleModelChange: vi.fn(),
    handleLocalBackendChange: vi.fn(),
    handleReasoningChange: vi.fn(),
    handleBaseUrlChange: vi.fn(),
    handleContextLengthChange: vi.fn(),
  }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-provider-secrets', () => ({
  useProviderSecrets: () => ({ data: { secrets: {} } }),
  useSaveProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteProviderSecret: () => ({ mutate: vi.fn(), isPending: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-models', () => ({
  useModels: () => ({ data: { models: [] }, isPending: false }),
}));

mock.module('../../packages/myco/ui/src/components/providers/ProviderModelSelector', () => ({
  ProviderModelSelector: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/ReasoningProfiles', () => ({
  ReasoningProfiles: () => null,
}));
mock.module('../../packages/myco/ui/src/components/providers/AdvancedModelPin', () => ({
  AdvancedModelPin: () => null,
}));

import { AgentProviderCard } from '../../packages/myco/ui/src/components/settings/AgentProviderCard';

describe('AgentProviderCard empty state', () => {
  it('renders the no-provider hint inside the consistent bordered empty-state callout', () => {
    const { container } = render(<AgentProviderCard />);

    // The hint text renders…
    expect(screen.getByText(/No provider configured/)).toBeTruthy();
    expect(screen.getByText(/Configure a provider/)).toBeTruthy();

    // …promoted into the shared empty-state treatment (a bordered callout box),
    // not a bare inline paragraph.
    const callout = container.querySelector('[data-empty-state="agent-provider"]');
    expect(callout).not.toBeNull();
    expect(callout?.className).toContain('border');
    // The message lives inside the callout container.
    expect(callout?.textContent).toContain('No provider configured');
  });
});
