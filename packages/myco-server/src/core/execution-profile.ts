import { PROFILE_HARNESSES, isReasoningTier, modelRefusal, effortRefusal, profileSupported, type ExecutionProfile, type ProfileCapability } from '@goondocks/myco-shared/execution-profile';
import { invalidTaskTier } from '@goondocks/myco-shared/run-holds';
import { noModelForTier, profileUnsupported } from '@goondocks/myco-shared/run-holds';
import { TASK_TIERS } from './task-catalogue.js';

export const PROFILE_SETTING_LEAVES = Object.keys(PROFILE_HARNESSES).flatMap((harness) => [
  ...Object.keys(PROFILE_HARNESSES[harness]!.models).flatMap((tier) => [`agent.reasoning_map.${harness}.${tier}`, `agent.effort_map.${harness}.${tier}`]),
  `agent.harnesses.${harness}.credential`,
]);

/** Decode a stored leaf; malformed settings remain a visible resolution refusal. */
export function profileSetting(raw: string | undefined): unknown {
  if (raw === undefined) return undefined;
  try { return JSON.parse(raw); } catch { return null; }
}

export const taskOverride = (settings: ReadonlyMap<string, string>, task: string): Record<string, unknown> => {
  const tasks = profileSetting(settings.get('agent.tasks'));
  if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks)) return {};
  const value: unknown = (tasks as Record<string, unknown>)[task];
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
};

export type ProfileResolution = { profile: ExecutionProfile } | { reason: string };

/** A malformed stored task tier holds this task by name until Settings repairs it. */
export function taskTierRefusal(task: string, settings: ReadonlyMap<string, string>): string | null {
  const tasks = profileSetting(settings.get('agent.tasks'));
  if (tasks === undefined) return null;
  if (tasks === null || typeof tasks !== 'object' || Array.isArray(tasks)) return invalidTaskTier(task);
  const entry: unknown = (tasks as Record<string, unknown>)[task];
  if (entry === undefined) return null;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return invalidTaskTier(task);
  const tier = (entry as Record<string, unknown>).reasoningLevel;
  return tier === undefined || isReasoningTier(tier) ? null : invalidTaskTier(task);
}

/** Resolve settings only for the harness whose capability can apply them. */
export function resolveExecutionProfile(task: string, harness: string, capability: ProfileCapability | undefined, settings: ReadonlyMap<string, string>): ProfileResolution {
  const unsupported = { reason: profileUnsupported(harness) };
  const tierRefusal = taskTierRefusal(task, settings);
  if (tierRefusal !== null) return { reason: tierRefusal };
  if (capability === undefined || capability.model === 'none') return unsupported;
  const override = taskOverride(settings, task);
  const tier = override.reasoningLevel === undefined ? TASK_TIERS[task] : override.reasoningLevel;
  if (!isReasoningTier(tier)) return unsupported;
  const defaults = PROFILE_HARNESSES[harness];
  const configuredModel = profileSetting(settings.get(`agent.reasoning_map.${harness}.${tier}`));
  const pinned = override.harness === harness && override.model !== undefined;
  const model = pinned ? override.model : configuredModel === undefined ? defaults?.models[tier] : configuredModel;
  if (model === undefined || model === null) return { reason: noModelForTier(harness, tier) };
  const configuredEffort = profileSetting(settings.get(`agent.effort_map.${harness}.${tier}`));
  const effort = configuredEffort === undefined ? defaults?.efforts[tier] ?? null : configuredEffort;
  if (configuredEffort === null) return unsupported;
  if (modelRefusal(harness, model) !== null || (effort !== null && effortRefusal(harness, effort) !== null)) return unsupported;
  const profile: ExecutionProfile = {
    tier, model: model as string, effort: effort as string | null,
    sources: { tier: override.reasoningLevel === undefined ? 'task' : 'task-override', model: pinned ? 'task-pin' : configuredModel === undefined ? 'default' : 'configured' },
  };
  return profileSupported(profile, capability) ? { profile } : unsupported;
}
