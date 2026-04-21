import { HOOK_CONFIG } from './hook-config.generated.js';
import type { SymbiontRegistration } from '../symbionts/manifest-schema.js';

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
  const config = resolveHookResponseConfig(symbiont);
  switch (config.format) {
    case 'json':
      process.stdout.write(serializeJson(response, config.fieldNames ?? {}));
      return;
    case 'plain-text':
      if (response.additionalContext) process.stdout.write(response.additionalContext);
      return;
  }
  void hookEvent;
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
