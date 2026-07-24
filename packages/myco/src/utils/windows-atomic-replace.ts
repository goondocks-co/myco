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
import { dlopen, FFIType, ptr } from 'bun:ffi';
import path from 'node:path';

const MOVEFILE_REPLACE_EXISTING = 0x1;
const MOVEFILE_WRITE_THROUGH = 0x8;
const ERROR_FILE_NOT_FOUND = 2;
const ERROR_PATH_NOT_FOUND = 3;

export const WINDOWS_ATOMIC_REPLACE_FLAGS =
  MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;

export interface WindowsMoveFileApi {
  moveFileEx(
    sourcePath: Uint8Array,
    destinationPath: Uint8Array,
    flags: number,
  ): number;
  getLastError(): number;
}

export class WindowsMoveFileError extends Error {
  readonly code: 'ENOENT' | undefined;

  constructor(
    sourcePath: string,
    destinationPath: string,
    readonly win32ErrorCode: number,
  ) {
    super(
      `MoveFileExW failed replacing ${destinationPath} from ${sourcePath} `
      + `(GetLastError ${win32ErrorCode})`,
    );
    this.name = 'WindowsMoveFileError';
    this.code = win32ErrorCode === ERROR_FILE_NOT_FOUND
      || win32ErrorCode === ERROR_PATH_NOT_FOUND
      ? 'ENOENT'
      : undefined;
  }
}

export function toWindowsNamespacedPath(filePath: string): string {
  return path.win32.toNamespacedPath(filePath);
}

function encodeWidePath(filePath: string): Uint8Array {
  if (filePath.includes('\0')) {
    throw new Error('MoveFileExW path must not contain a NUL character');
  }
  return Buffer.from(`${filePath}\0`, 'utf16le');
}

export function moveFileReplaceWriteThroughWith(
  api: WindowsMoveFileApi,
  sourcePath: string,
  destinationPath: string,
): void {
  const sourceBuffer = encodeWidePath(sourcePath);
  const destinationBuffer = encodeWidePath(destinationPath);
  const result = api.moveFileEx(
    sourceBuffer,
    destinationBuffer,
    WINDOWS_ATOMIC_REPLACE_FLAGS,
  );
  if (result === 0) {
    const lastError = api.getLastError();
    throw new WindowsMoveFileError(sourcePath, destinationPath, lastError);
  }
}

interface Kernel32 {
  MoveFileExW(sourcePath: number, destinationPath: number, flags: number): number;
  GetLastError(): number;
}

let nativeApi: WindowsMoveFileApi | undefined;
let nativeApiError: Error | undefined;

function loadNativeApi(): WindowsMoveFileApi {
  if (nativeApi) return nativeApi;
  if (nativeApiError) throw nativeApiError;
  try {
    const library = dlopen('kernel32.dll', {
      MoveFileExW: {
        args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      GetLastError: { args: [], returns: FFIType.u32 },
    });
    const kernel32 = library.symbols as unknown as Kernel32;
    nativeApi = {
      moveFileEx: (sourcePath, destinationPath, flags) => (
        kernel32.MoveFileExW(ptr(sourcePath), ptr(destinationPath), flags)
      ),
      getLastError: () => kernel32.GetLastError(),
    };
    return nativeApi;
  } catch (error) {
    nativeApiError = new Error(
      `Failed to bind MoveFileExW for durable Windows file publication: ${(error as Error).message}`,
    );
    throw nativeApiError;
  }
}

export function moveFileReplaceWriteThrough(
  sourcePath: string,
  destinationPath: string,
): void {
  if (process.platform !== 'win32') {
    throw new Error('MoveFileExW publication is only available on Windows');
  }
  moveFileReplaceWriteThroughWith(
    loadNativeApi(),
    path.toNamespacedPath(sourcePath),
    path.toNamespacedPath(destinationPath),
  );
}
