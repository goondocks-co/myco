import { assertion } from '../index.js';

export function observedSettingsAssertion(predicate: string) {
  return assertion<[revisions: string]>({ name: 'meta.settingsRevisionUnchanged', sql:
    `SELECT CASE WHEN ${predicate} THEN 1 ELSE json_extract('[]','$[settings_revision_conflict]') END` });
}
