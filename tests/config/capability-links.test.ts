import { describe, it, expect } from 'bun:test';
import { CAPABILITIES } from '../../packages/myco/src/config/capabilities';
import { SETTINGS_GROUPS } from '../../packages/myco/ui/src/settings/manifest';

// Capability links are either a settings-group hash (/settings#<group>) or a
// dedicated top-level page route. Page routes are allowlisted here; the OKF
// page itself ships in the UI plan (interim unknown-route <Link> renders
// harmlessly — accepted by the master plan).
const KNOWN_PAGE_ROUTES = new Set(['/okf']);

describe('capability advancedSettingsLink routes resolve', () => {
  const groupIds = new Set(SETTINGS_GROUPS.map((g) => g.id));
  it('every advancedSettingsLink resolves to a settings group or a known page route', () => {
    const bad: string[] = [];
    for (const cap of Object.values(CAPABILITIES)) {
      const hash = cap.advancedSettingsLink.split('#')[1];
      if (hash ? !groupIds.has(hash) : !KNOWN_PAGE_ROUTES.has(cap.advancedSettingsLink)) {
        bad.push(`${cap.id}: ${cap.advancedSettingsLink}`);
      }
    }
    if (bad.length) throw new Error(`Unresolvable capability links:\n  ${bad.join('\n  ')}`);
  });
});
