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

  try {
    assertValidSecretEntry(envKey, raw);
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

  const value = raw.trim();
  return value
    ? { ok: true, value }
    : { ok: false, response: missingResponse };
}
