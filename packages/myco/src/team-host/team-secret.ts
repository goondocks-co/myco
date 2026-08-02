/**
 * Copyright 2026 Chris Kirby
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * The ONE writer for the team's LLM provider key into served-grove secrets —
 * shared by the compose (`--serve` installer) path and the host-admin enable
 * route (E1 §9.3: the route deliberately does not call compose, so the
 * secret step is extracted rather than duplicated).
 *
 * The key is stored under the PROVIDER-STANDARD env name (never
 * `TEAM_AGENT_KEY_SECRET`, which is only the CLI-flag/env transport name a
 * real dispatch never reads). The provider is REQUIRED: the old
 * `?? 'anthropic'` default silently filed a non-Anthropic team's key under
 * `ANTHROPIC_API_KEY` — key present, dispatch keyless, nothing obviously
 * wrong (E1 §9.2, review correction: compose DID default, despite its own
 * comment claiming it refused).
 */
import { KEYED_CLOUD_PROVIDER_ENV } from '@myco/agent/harness/provider-health.js';
import { writeSecret } from '@myco/config/secrets.js';
import type { PerUserLockNamespace } from '@myco/utils/per-user-lock-namespace.js';
import { resolveGroveDir, resolveMycoHome } from '@myco/grove/paths.js';

export interface WriteTeamAgentKeyInput {
  servedGroveId: string;
  key: string;
  provider: keyof typeof KEYED_CLOUD_PROVIDER_ENV;
  mycoHome?: string;
  lockNamespace?: PerUserLockNamespace;
}

/** First-8+last-4 masking, matching the masked-echo contract secrets are
 *  never printed in full under (server-mode design spec §5/§6). Moved here
 *  from compose.ts with the extraction — one mask, one writer. */
export function maskTeamAgentKey(secret: string): string {
  const PREFIX = 8;
  const SUFFIX = 4;
  if (secret.length <= PREFIX + SUFFIX) return '*'.repeat(secret.length);
  return `${secret.slice(0, PREFIX)}${'*'.repeat(secret.length - PREFIX - SUFFIX)}${secret.slice(-SUFFIX)}`;
}

/** Store the team agent key in the served Grove's secrets under the
 *  provider's standard env name. Returns the masked echo. */
export function writeTeamAgentKey(input: WriteTeamAgentKeyInput): string {
  const key = input.key.trim();
  if (!key) throw new Error('Team agent key is empty.');
  const envKey = KEYED_CLOUD_PROVIDER_ENV[input.provider]?.[0];
  if (!envKey) {
    throw new Error(
      `Unknown team key provider "${String(input.provider)}" — expected one of: `
      + Object.keys(KEYED_CLOUD_PROVIDER_ENV).join(', '),
    );
  }
  const mycoHome = input.mycoHome ?? resolveMycoHome();
  const groveDir = resolveGroveDir(input.servedGroveId, mycoHome);
  writeSecret(groveDir, envKey, key, input.lockNamespace);
  return maskTeamAgentKey(key);
}
