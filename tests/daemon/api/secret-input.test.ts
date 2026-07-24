/*
 * Copyright 2026 Myco Contributors
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
import { describe, expect, test } from 'bun:test';

import { normalizeRawSecretInput } from '@myco/daemon/api/secret-input.js';
import type { RouteResponse } from '@myco/daemon/router.js';

const MISSING_RESPONSE: RouteResponse = {
  status: 400,
  body: { error: 'missing_secret' },
};

describe('secret API input normalization', () => {
  test('returns an exact validated secret value', () => {
    expect(normalizeRawSecretInput('API_TOKEN', 'secret-value', MISSING_RESPONSE))
      .toEqual({ ok: true, value: 'secret-value' });
  });

  test.each([undefined, null, 42, ''])(
    'returns the caller-provided missing response for %p',
    (raw) => {
      expect(normalizeRawSecretInput('API_TOKEN', raw, MISSING_RESPONSE))
        .toEqual({ ok: false, response: MISSING_RESPONSE });
    },
  );

  test.each([
    ['API_TOKEN', ' secret-value '],
    ['API_TOKEN', 'secret\nvalue'],
    ['not-portable!', 'secret-value'],
  ])('surfaces invalid secret input for key %s', (envKey, raw) => {
    expect(normalizeRawSecretInput(envKey, raw, MISSING_RESPONSE)).toMatchObject({
      ok: false,
      response: {
        status: 400,
        body: { error: 'invalid_secret_value' },
      },
    });
  });
});
