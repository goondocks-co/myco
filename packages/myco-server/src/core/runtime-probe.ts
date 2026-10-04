import type { ServerEnv } from './adapters.js';
import { profileSetting } from './execution-profile.js';
import { DEPLOYMENT_LEAF_SPECS, executionProfileLeafDefault, leafRuleViolation, settingTexts } from './settings.js';

const CLAUDE_DEFAULT_MODEL_LEAF = 'agent.reasoning_map.claude-code.default';

/** The retained container check uses Claude Code's current default-tier model. */
export async function runtimeProbeModel(env: Pick<ServerEnv, 'db' | 'harnessCredentialSource'>, task: string): Promise<string | null> {
  if (task !== 'container-smoke') throw new Error('The runtime probe model is only for the retained container probe');
  const settings = await settingTexts(env.db, [CLAUDE_DEFAULT_MODEL_LEAF]);
  const configured = profileSetting(settings.get(CLAUDE_DEFAULT_MODEL_LEAF));
  const model = configured === undefined ? executionProfileLeafDefault(CLAUDE_DEFAULT_MODEL_LEAF, env.harnessCredentialSource)?.value : configured;
  return leafRuleViolation(DEPLOYMENT_LEAF_SPECS[CLAUDE_DEFAULT_MODEL_LEAF]!, model) === null ? model as string : null;
}
