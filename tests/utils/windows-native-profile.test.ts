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
import { describe, expect, it } from 'bun:test';

import {
  resolveWindowsNativeProfileWith,
  type WindowsKnownFolderApi,
} from '@myco/utils/windows-native-profile.js';

function fakeKnownFolderApi(options: {
  initializeResult?: number;
  folderResult?: number;
  pointer?: bigint;
  content?: string;
} = {}): WindowsKnownFolderApi & { calls: string[] } {
  const calls: string[] = [];
  const encoded = [...(options.content ?? 'C:\\Users\\Native')].map((char) => char.charCodeAt(0));
  return {
    calls,
    initialize() {
      calls.push('initialize');
      return options.initializeResult ?? 0;
    },
    getProfilePath(_folderId, output) {
      calls.push('getProfilePath');
      output[0] = options.pointer ?? 0x1234n;
      return options.folderResult ?? 0;
    },
    readUtf16(_pointer, byteOffset) {
      return encoded[byteOffset / 2] ?? 0;
    },
    free(pointer) {
      calls.push(`free:${pointer}`);
    },
    uninitialize() {
      calls.push('uninitialize');
    },
  };
}

describe('Windows native profile resolver contract', () => {
  it('decodes the bounded UTF-16 profile and balances COM initialization', () => {
    const api = fakeKnownFolderApi({ content: 'D:\\Profiles\\Živa' });

    expect(resolveWindowsNativeProfileWith(api)).toBe('D:\\Profiles\\Živa');
    expect(api.calls).toEqual([
      'initialize',
      'getProfilePath',
      'free:4660',
      'uninitialize',
    ]);
  });

  it('frees a non-null result and uninitializes when the known-folder call fails', () => {
    const api = fakeKnownFolderApi({ folderResult: -2147467259 });

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/SHGetKnownFolderPath/);
    expect(api.calls).toEqual([
      'initialize',
      'getProfilePath',
      'free:4660',
      'uninitialize',
    ]);
  });

  it('proceeds after RPC_E_CHANGED_MODE without uninitializing another apartment', () => {
    const api = fakeKnownFolderApi({ initializeResult: -2147417850 });

    expect(resolveWindowsNativeProfileWith(api)).toBe('C:\\Users\\Native');
    expect(api.calls).not.toContain('uninitialize');
    expect(api.calls).toContain('free:4660');
  });

  it('rejects a null native result without an environment fallback', () => {
    const api = fakeKnownFolderApi({ pointer: 0n });

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/null profile path/);
    expect(api.calls).toEqual(['initialize', 'getProfilePath', 'uninitialize']);
  });

  it('bounds unterminated native UTF-16 output and still frees it', () => {
    const api = fakeKnownFolderApi();
    api.readUtf16 = () => 65;

    expect(() => resolveWindowsNativeProfileWith(api)).toThrow(/not NUL-terminated/);
    expect(api.calls).toContain('free:4660');
    expect(api.calls).toContain('uninitialize');
  });
});
