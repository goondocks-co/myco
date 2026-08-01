/*
 * Copyright 2026 Goondocks.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {
  assertValidSecretEntry,
  InvalidSecretValueError,
} from '@myco/config/secrets.js';
import type { RouteResponse } from '@myco/daemon/router.js';

type NormalizedSecretInput =
  | { ok: true; value: string }
  | { ok: false; response: RouteResponse };

export function normalizeRawSecretInput(
  envKey: string,
  raw: unknown,
  missingResponse: RouteResponse,
): NormalizedSecretInput {
  if (typeof raw !== 'string') return { ok: false, response: missingResponse };

  // Strip HORIZONTAL whitespace (spaces/tabs) everywhere, not just the
  // ends. No credential this normalizer handles (API keys, PATs, OAuth
  // tokens, team keys) legitimately contains spaces — but a token copied
  // from a soft-wrapped terminal arrives with spaces at the wrap columns.
  // Verified live: a wrapped `claude setup-token` paste stored four
  // interior spaces, and every harness run failed 401 while Settings and
  // doctor showed green. Repairing at this boundary (the single choke
  // point for machine and team secret writes) makes that paste shape
  // impossible to store broken.
  //
  // Line-structure characters (\n, \r) are deliberately NOT repaired:
  // they are the secrets.env injection alphabet ("valid\nINJECTED=owned"),
  // and the validation below must keep rejecting them outright — an
  // attack-shaped input gets an error, never a silent rewrite.
  const value = raw.replace(/[ \t]+/g, '');
  if (!value) return { ok: false, response: missingResponse };

  try {
    assertValidSecretEntry(envKey, value);
  } catch (error) {
    if (error instanceof InvalidSecretValueError) {
      return {
        ok: false,
        response: {
          status: 400,
          body: { error: error.code, message: error.message },
        },
      };
    }
    throw error;
  }

  return { ok: true, value };
}
