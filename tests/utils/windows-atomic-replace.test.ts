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
import {
  WINDOWS_ATOMIC_REPLACE_FLAGS,
  moveFileReplaceWriteThroughWith,
  toWindowsNamespacedPath,
  type WindowsMoveFileApi,
} from '@myco/utils/windows-atomic-replace.js';

function decodeWidePath(buffer: Uint8Array): string {
  const value = Buffer.from(buffer).toString('utf16le');
  expect(value.endsWith('\0')).toBe(true);
  return value.slice(0, -1);
}

describe('Windows atomic replacement contract', () => {
  test('converts drive and UNC paths to stable extended-length forms', () => {
    expect(toWindowsNamespacedPath('C:\\Users\\Mýco\\secrets.env'))
      .toBe('\\\\?\\C:\\Users\\Mýco\\secrets.env');
    expect(toWindowsNamespacedPath('\\\\server\\share\\secrets.env'))
      .toBe('\\\\?\\UNC\\server\\share\\secrets.env');
    expect(toWindowsNamespacedPath('\\\\?\\C:\\Users\\Mýco\\secrets.env'))
      .toBe('\\\\?\\C:\\Users\\Mýco\\secrets.env');
  });

  test('passes long Unicode and UNC paths as exact NUL-terminated UTF-16 buffers', () => {
    const source = `\\\\?\\UNC\\server\\share\\${'深'.repeat(300)}\\secrets.tmp`;
    const destination = `\\\\?\\C:\\Users\\Mýco\\${'d'.repeat(300)}\\secrets.env`;
    const calls: Array<{ source: string; destination: string; flags: number }> = [];
    const api: WindowsMoveFileApi = {
      moveFileEx: (sourceBuffer, destinationBuffer, flags) => {
        calls.push({
          source: decodeWidePath(sourceBuffer),
          destination: decodeWidePath(destinationBuffer),
          flags,
        });
        return 1;
      },
      getLastError: () => {
        throw new Error('GetLastError must not run after success');
      },
    };

    moveFileReplaceWriteThroughWith(api, source, destination);

    expect(calls).toEqual([{
      source,
      destination,
      flags: WINDOWS_ATOMIC_REPLACE_FLAGS,
    }]);
    expect(WINDOWS_ATOMIC_REPLACE_FLAGS).toBe(0x9);
  });

  test('captures GetLastError immediately when MoveFileExW fails', () => {
    const events: string[] = [];
    const api: WindowsMoveFileApi = {
      moveFileEx: () => {
        events.push('move');
        return 0;
      },
      getLastError: () => {
        events.push('error');
        return 32;
      },
    };

    expect(() => moveFileReplaceWriteThroughWith(api, 'C:\\tmp', 'C:\\target'))
      .toThrow(/GetLastError 32/);
    expect(events).toEqual(['move', 'error']);
  });

  test.each([2, 3])(
    'normalizes Windows path-not-found error %d to idempotent ENOENT',
    (lastError) => {
      const api: WindowsMoveFileApi = {
        moveFileEx: () => 0,
        getLastError: () => lastError,
      };

      const error = (() => {
        try {
          moveFileReplaceWriteThroughWith(api, 'C:\\missing', 'C:\\tombstone');
          return null;
        } catch (caught) {
          return caught;
        }
      })();

      expect(error).toMatchObject({
        code: 'ENOENT',
        win32ErrorCode: lastError,
      });
    },
  );

  test('rejects embedded NULs before calling the native API', () => {
    let called = false;
    const api: WindowsMoveFileApi = {
      moveFileEx: () => {
        called = true;
        return 1;
      },
      getLastError: () => 0,
    };

    expect(() => moveFileReplaceWriteThroughWith(api, 'C:\\tmp\0shadow', 'C:\\target'))
      .toThrow(/NUL/);
    expect(called).toBe(false);
  });
});
