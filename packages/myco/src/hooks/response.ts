import { HOOK_CONFIG } from './hook-config.generated.js';
import type { SymbiontRegistration } from '../symbionts/manifest-schema.js';
import { symbiontHasCapability } from '../symbionts/capabilities.js';

export interface HookResponse {
  additionalContext?: string;
  continue?: boolean;
  stopReason?: string;
  userMessage?: string;
  followupMessage?: string;
  systemMessage?: string;
}

type SemanticField = keyof HookResponse;

export function writeHookResponse(
  symbiont: string | undefined,
  hookEvent: string,
  response: HookResponse = {},
): void {
  if (hookEvent === 'pre-tool-use' && symbiontHasCapability(symbiont, 'preToolUseInjection')) {
    process.stdout.write(serializePreToolUseEnvelope(response));
    return;
  }

  const config = resolveHookResponseConfig(symbiont);
  switch (config.format) {
    case 'json':
      process.stdout.write(serializeJson(response, config.fieldNames ?? {}));
      return;
    case 'plain-text':
      if (response.additionalContext) process.stdout.write(response.additionalContext);
      return;
    case 'antigravity-inject-steps':
      process.stdout.write(serializeAntigravityResponse(hookEvent, response));
      return;
  }
  void hookEvent;
}

/**
 * Antigravity response shapes per https://antigravity.google/docs/hooks:
 *   - PreInvocation: `{ injectSteps: [{ userMessage: "<text>" }] }` (or `{}` when nothing to inject)
 *   - PostToolUse:   `{}`
 *   - Stop:          `{ decision: "continue" | "allow" }` — `decision` is required; `"continue"` force-continues.
 *
 * `userMessage` is the persistent injection form; `ephemeralMessage` is silently
 * dropped from the model's trajectory in the AGY CLI surface.
 */
function serializeAntigravityResponse(hookEvent: string, response: HookResponse): string {
  if (hookEvent === 'stop') {
    return JSON.stringify({ decision: 'allow' });
  }
  if (hookEvent === 'session-start' || hookEvent === 'user-prompt-submit') {
    if (!response.additionalContext) return '{}';
    return JSON.stringify({
      injectSteps: [{ userMessage: response.additionalContext }],
    });
  }
  return '{}';
}

type HookResponseConfig = NonNullable<SymbiontRegistration['hookResponse']>;

const DEFAULT_CONFIG: HookResponseConfig = { format: 'plain-text' };

function resolveHookResponseConfig(symbiont: string | undefined): HookResponseConfig {
  if (!symbiont) return DEFAULT_CONFIG;
  return HOOK_CONFIG[symbiont]?.hookResponse ?? DEFAULT_CONFIG;
}

function serializeJson(
  response: HookResponse,
  fieldNames: Record<string, string>,
): string {
  const body: Record<string, unknown> = {};
  for (const [semantic, value] of Object.entries(response) as Array<[SemanticField, unknown]>) {
    if (value === undefined) continue;
    const wire = fieldNames[semantic];
    if (!wire) continue;
    body[wire] = value;
  }
  return JSON.stringify(body);
}

function serializePreToolUseEnvelope(response: HookResponse): string {
  if (!response.additionalContext) return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: response.additionalContext,
    },
  });
}
