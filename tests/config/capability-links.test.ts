import { describe, it, expect } from 'bun:test';
import { CAPABILITIES } from '../../packages/myco/src/config/capabilities';
import { SETTINGS_GROUPS } from '../../packages/myco/ui/src/settings/manifest';

describe('capability advancedSettingsLink routes resolve', () => {
  const groupIds = new Set(SETTINGS_GROUPS.map((g) => g.id));
  it('every advancedSettingsLink hash matches a real settings group id', () => {
    const bad: string[] = [];
    for (const cap of Object.values(CAPABILITIES)) {
      const hash = cap.advancedSettingsLink.split('#')[1];
      if (!hash || !groupIds.has(hash)) bad.push(`${cap.id}: ${cap.advancedSettingsLink}`);
    }
    if (bad.length) throw new Error(`Unresolvable capability links:\n  ${bad.join('\n  ')}`);
  });
});
