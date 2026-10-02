import type { RelationalStore } from './adapters.js';
import { settingsWriter } from './settings.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Archived runtime preferences for the retained container probe; editable worker profiles are independent. */
export async function runtimeProbePreferences(db: RelationalStore, task: string): Promise<{ type: string | null; model: string | null; baseUrl: string | null }> {
  if (task !== 'container-smoke') throw new Error('Archived provider preferences are only for the retained container probe');
  const stored = await settingsWriter(db).leaves();
  const overrides = stored['agent.tasks']?.value;
  const entry = isRecord(overrides) && isRecord(overrides[task]) ? overrides[task] : {};
  const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
  return {
    type: text(entry.provider) ?? text(stored['agent.provider.type']?.value),
    model: text(entry.model) ?? text(stored['agent.provider.model']?.value),
    baseUrl: text(stored['agent.provider.base_url']?.value),
  };
}
