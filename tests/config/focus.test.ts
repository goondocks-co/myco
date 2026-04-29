import { describe, expect, it } from 'bun:test';
import {
  CONFIG_SECTION_IDS,
  buildConfigFocusLink,
  buildScopedConfigSaveNotification,
  configFieldId,
  resolveConfigFocusTarget,
} from '@myco/config/focus';

describe('config focus helpers', () => {
  it('resolves cortex.spores.inject_on_prompt_submit to the Cortex instructions section', () => {
    const target = resolveConfigFocusTarget('cortex.spores.inject_on_prompt_submit');

    expect(target).toEqual({
      page: '/cortex',
      sectionId: CONFIG_SECTION_IDS.cortexInstructions,
      sectionLabel: 'Instructions',
      fieldPath: 'cortex.spores.inject_on_prompt_submit',
      fieldLabel: 'Prompt-Submit Spore Injection',
    });
  });

  it('builds a focus link with section and field params', () => {
    const target = resolveConfigFocusTarget('cortex.spores.inject_on_prompt_submit');
    expect(target).not.toBeNull();
    expect(buildConfigFocusLink(target!)).toBe(
      `/cortex?configSection=${CONFIG_SECTION_IDS.cortexInstructions}&configField=cortex.spores.inject_on_prompt_submit`,
    );
  });

  it('formats settings save notifications with an exact field label and link', () => {
    const summary = buildScopedConfigSaveNotification('project', ['cortex.spores.inject_on_prompt_submit']);

    expect(summary.title).toBe('Prompt-Submit Spore Injection saved');
    expect(summary.message).toBe('Instructions · Prompt-Submit Spore Injection · Project');
    expect(summary.link).toBe(
      `/cortex?configSection=${CONFIG_SECTION_IDS.cortexInstructions}&configField=cortex.spores.inject_on_prompt_submit`,
    );
    expect(summary.metadata.focus_target).toEqual({
      page: '/cortex',
      section_id: CONFIG_SECTION_IDS.cortexInstructions,
      field_path: 'cortex.spores.inject_on_prompt_submit',
      field_label: 'Prompt-Submit Spore Injection',
    });
  });

  it('falls back to ancestor field ids for custom cards', () => {
    expect(configFieldId('agent.provider.model')).toBe('config-field-agent-provider-model');
    expect(configFieldId('agent.provider')).toBe('config-field-agent-provider');
  });
});
