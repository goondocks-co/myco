import { assertion, refusalCode } from '../index.js';

export const SETTINGS_REVISION_CONFLICT = refusalCode('settings_revision_conflict');

export function observedSettingsAssertion(predicate: string) {
  return assertion<[revisions: string]>({ name: 'meta.settingsRevisionUnchanged', refusal: SETTINGS_REVISION_CONFLICT, when: predicate });
}
