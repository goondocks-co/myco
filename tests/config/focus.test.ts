import { describe, expect, it } from 'bun:test';
import {
  CONFIG_SECTION_IDS,
  buildConfigFocusLink,
  buildScopedConfigSaveNotification,
  configFieldId,
  resolveConfigFocusTarget,
} from '@myco/config/focus';

describe('config focus helpers', () => {
  it('resolves context.prompt_search to the Cortex instructions section', () => {
    const target = resolveConfigFocusTarget('context.prompt_search');

    expect(target).toEqual({
      page: '/cortex',
      sectionId: CONFIG_SECTION_IDS.cortexInstructions,
      sectionLabel: 'Instructions',
      fieldPath: 'context.prompt_search',
      fieldLabel: 'Prompt Search',
    });
  });

  it('builds a focus link with section and field params', () => {
    const target = resolveConfigFocusTarget('context.prompt_search');
    expect(target).not.toBeNull();
    expect(buildConfigFocusLink(target!)).toBe(
      `/cortex?configSection=${CONFIG_SECTION_IDS.cortexInstructions}&configField=context.prompt_search`,
    );
  });

  it('formats settings save notifications with an exact field label and link', () => {
    const summary = buildScopedConfigSaveNotification('project', ['context.prompt_search']);

    expect(summary.title).toBe('Prompt Search saved');
    expect(summary.message).toBe('Instructions · Prompt Search · Project');
    expect(summary.link).toBe(
      `/cortex?configSection=${CONFIG_SECTION_IDS.cortexInstructions}&configField=context.prompt_search`,
    );
    expect(summary.metadata.focus_target).toEqual({
      page: '/cortex',
      section_id: CONFIG_SECTION_IDS.cortexInstructions,
      field_path: 'context.prompt_search',
      field_label: 'Prompt Search',
    });
  });

  it('falls back to ancestor field ids for custom cards', () => {
    expect(configFieldId('agent.provider.model')).toBe('config-field-agent-provider-model');
    expect(configFieldId('agent.provider')).toBe('config-field-agent-provider');
  });
});
