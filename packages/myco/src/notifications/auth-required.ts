/**
 * The auth-required notification for agent runs.
 *
 * A run failing with `errorKind: 'auth'` means the spawned Claude CLI has no
 * headless credential — a machine-wide condition every subsequent
 * Anthropic-provider run shares. All failure-notify sites route through
 * these helpers so the user gets ONE actionable notification (daemon scope +
 * notify()'s dedup window) that deep-links to the Settings card where the
 * token is pasted, instead of a generic per-run failure whose remediation
 * they'd have to dig out of the error text.
 */

import type { AgentRunResult } from '@myco/agent/types.js';
import { buildConfigFocusLink, resolveConfigFocusTarget } from '@myco/config/focus.js';
import type { CreateNotificationPayload } from './types.js';

export const AGENT_AUTH_REQUIRED_TYPE = 'agent.auth.required';

/** Config path whose focus rule targets the Settings → Myco Agent card. */
const AGENT_PROVIDER_CONFIG_PATH = 'agent.provider';

/** Whether a run result should surface as auth-required rather than a generic failure. */
export function isAuthRequiredFailure(result: Pick<AgentRunResult, 'status' | 'errorKind'>): boolean {
  return result.status === 'failed' && result.errorKind === 'auth';
}

/** Deep link to the Settings card that holds the Claude subscription row. */
export function agentSettingsFocusLink(): string {
  const target = resolveConfigFocusTarget(AGENT_PROVIDER_CONFIG_PATH);
  return target ? buildConfigFocusLink(target) : '/settings';
}

export function buildAuthRequiredNotification(
  taskName: string | null,
  runId: string,
): CreateNotificationPayload {
  return {
    domain: 'agents',
    type: AGENT_AUTH_REQUIRED_TYPE,
    title: 'Background tasks need a one-time credential',
    message: 'Agent runs can’t sign in to Claude. Connect your Claude subscription under Settings → Myco Agent: run `claude setup-token` in your terminal and paste the result.',
    link: agentSettingsFocusLink(),
    metadata: { taskName, runId },
  };
}
