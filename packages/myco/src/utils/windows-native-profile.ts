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
import path from 'node:path';
import { dlopen, FFIType, ptr, read } from 'bun:ffi';

const S_OK = 0;
const S_FALSE = 1;
const RPC_E_CHANGED_MODE = -2147417850;
const COINIT_APARTMENTTHREADED = 0x2;
const MAX_PROFILE_CODE_UNITS = 32_768;

const FOLDER_ID_PROFILE = new Uint8Array([
  0x8f, 0x85, 0x6c, 0x5e,
  0x22, 0x0e,
  0x60, 0x47,
  0x9a, 0xfe, 0xea, 0x33, 0x17, 0xb6, 0x71, 0x73,
]);

export interface WindowsKnownFolderApi {
  initialize(): number;
  getProfilePath(folderId: Uint8Array, output: BigUint64Array): number;
  readUtf16(pointer: number, byteOffset: number): number;
  free(pointer: number): void;
  uninitialize(): void;
}

function decodeUtf16(pointer: number, api: WindowsKnownFolderApi): string {
  const units: number[] = [];
  for (let index = 0; index < MAX_PROFILE_CODE_UNITS; index += 1) {
    const unit = api.readUtf16(pointer, index * 2);
    if (unit === 0) {
      const chunks: string[] = [];
      for (let start = 0; start < units.length; start += 4096) {
        chunks.push(String.fromCharCode(...units.slice(start, start + 4096)));
      }
      return chunks.join('');
    }
    units.push(unit);
  }
  throw new Error('Windows native profile path is not NUL-terminated within the supported bound');
}

export function resolveWindowsNativeProfileWith(api: WindowsKnownFolderApi): string {
  const initializeResult = api.initialize();
  const shouldUninitialize = initializeResult === S_OK || initializeResult === S_FALSE;
  if (!shouldUninitialize && initializeResult !== RPC_E_CHANGED_MODE) {
    throw new Error(`CoInitializeEx failed while resolving the Windows profile (HRESULT ${initializeResult})`);
  }

  const output = new BigUint64Array(1);
  let nativePointer = 0;
  try {
    const result = api.getProfilePath(FOLDER_ID_PROFILE, output);
    nativePointer = Number(output[0]);
    if (!Number.isSafeInteger(nativePointer) || nativePointer < 0) {
      throw new Error('SHGetKnownFolderPath returned an invalid profile pointer');
    }
    if (result < 0) {
      throw new Error(`SHGetKnownFolderPath failed for FOLDERID_Profile (HRESULT ${result})`);
    }
    if (nativePointer === 0) {
      throw new Error('SHGetKnownFolderPath returned a null profile path');
    }

    const profile = decodeUtf16(nativePointer, api);
    if (!path.win32.isAbsolute(profile) || profile.includes('\0')) {
      throw new Error('SHGetKnownFolderPath returned an invalid absolute profile path');
    }
    return profile;
  } finally {
    if (nativePointer !== 0) api.free(nativePointer);
    if (shouldUninitialize) api.uninitialize();
  }
}

interface Shell32 {
  SHGetKnownFolderPath(
    folderId: number,
    flags: number,
    token: bigint,
    output: number,
  ): number;
}

interface Ole32 {
  CoInitializeEx(reserved: number, coInit: number): number;
  CoUninitialize(): void;
  CoTaskMemFree(memory: number): void;
}

let nativeApi: WindowsKnownFolderApi | undefined;
let nativeApiError: Error | undefined;

function loadNativeApi(): WindowsKnownFolderApi {
  if (nativeApi) return nativeApi;
  if (nativeApiError) throw nativeApiError;
  try {
    const shellLibrary = dlopen('shell32.dll', {
      SHGetKnownFolderPath: {
        args: [FFIType.ptr, FFIType.u32, FFIType.u64, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const oleLibrary = dlopen('ole32.dll', {
      CoInitializeEx: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
      CoUninitialize: { args: [], returns: FFIType.void },
      CoTaskMemFree: { args: [FFIType.ptr], returns: FFIType.void },
    });
    const shell = shellLibrary.symbols as unknown as Shell32;
    const ole = oleLibrary.symbols as unknown as Ole32;

    nativeApi = {
      initialize: () => ole.CoInitializeEx(0, COINIT_APARTMENTTHREADED),
      getProfilePath: (folderId, output) => (
        shell.SHGetKnownFolderPath(ptr(folderId), 0, 0n, ptr(output))
      ),
      readUtf16: (pointer, byteOffset) => read.u16(pointer as ReturnType<typeof ptr>, byteOffset),
      free: (pointer) => ole.CoTaskMemFree(pointer),
      uninitialize: () => ole.CoUninitialize(),
    };
    return nativeApi;
  } catch (error) {
    nativeApiError = new Error(
      `Failed to bind the native Windows profile resolver: ${(error as Error).message}`,
    );
    throw nativeApiError;
  }
}

let cachedProfile: string | undefined;
let cachedProfileError: Error | undefined;

export function resolveWindowsNativeProfile(): string {
  if (cachedProfile) return cachedProfile;
  if (cachedProfileError) throw cachedProfileError;
  try {
    cachedProfile = resolveWindowsNativeProfileWith(loadNativeApi());
    return cachedProfile;
  } catch (error) {
    cachedProfileError = error instanceof Error ? error : new Error(String(error));
    throw cachedProfileError;
  }
}
