import type { RelationalStore } from './adapters.js';
import { DEPLOYMENT_LEAF_SPECS, leafRuleViolation, settingTexts, settingsWriter } from './settings.js';

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

export interface ProbePreferences { type: string | null; model: string | null; baseUrl: string | null }

/** The probe's provider and model, including the fields a task override changes or cannot apply. */
export async function runtimeProbeResolution(db: RelationalStore): Promise<{
  preferences: ProbePreferences;
  overrides: Record<string, unknown>;
  reasons: string[];
  invalid: boolean;
}> {
  const stored = await settingsWriter(db).leaves();
  const valid = await settingTexts(db, ['agent.provider.type', 'agent.provider.model', 'agent.provider.base_url']);
  const preference = (leaf: string): string | null => {
    const raw = valid.get(leaf);
    return raw === undefined ? null : text(JSON.parse(raw));
  };
  const tasks = stored['agent.tasks']?.value;
  const entry = isRecord(tasks) && isRecord(tasks['container-smoke']) ? tasks['container-smoke'] : {};
  const reasons: string[] = [];
  let invalid = false;
  const overrides: Record<string, unknown> = {};
  const resolve = (field: 'provider' | 'model', leaf: string): string | null => {
    const held = entry[field];
    const normalized = text(held);
    const violation = held === undefined ? null : leafRuleViolation(DEPLOYMENT_LEAF_SPECS[leaf]!, held);
    if (violation !== null) { invalid = true; reasons.push(`container-smoke.${field}: ${violation}; the stored field does not apply.`); }
    const effective = normalized === null ? preference(leaf) : violation === null ? normalized : null;
    if (held !== undefined) overrides[field] = effective;
    if (violation === null && held !== undefined && held !== effective) reasons.push(`container-smoke.${field}: stored ${JSON.stringify(held)} resolves to ${JSON.stringify(effective)}.`);
    return effective;
  };
  const type = resolve('provider', 'agent.provider.type');
  const model = resolve('model', 'agent.provider.model');
  const preferences = { type, model: type === null ? null : model, baseUrl: type === 'openai-compatible' ? preference('agent.provider.base_url') : null };
  if (Object.hasOwn(overrides, 'model')) overrides.model = preferences.model;
  return { preferences, overrides, reasons, invalid };
}

/** The retained container smoke test's preferences; worker outcomes use their agent's execution profile. */
export async function runtimeProbePreferences(db: RelationalStore, task: string): Promise<ProbePreferences> {
  if (task !== 'container-smoke') throw new Error('Provider preferences are only for the retained container probe');
  return (await runtimeProbeResolution(db)).preferences;
}
