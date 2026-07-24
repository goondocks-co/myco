/*
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
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { resolveWindowsNativeProfile } from '@myco/utils/windows-native-profile.js';

export function resolveWindowsLockRootFromProfile(profile: string): string {
  if (!path.win32.isAbsolute(profile) || profile.includes('\0')) {
    throw new Error('Windows native profile path must be absolute');
  }
  return path.win32.join(profile, '.myco', 'locks');
}

function resolveWindowsLocksDir(): string {
  const lockRoot = resolveWindowsLockRootFromProfile(resolveWindowsNativeProfile());
  fs.mkdirSync(lockRoot, { recursive: true });
  const stat = fs.lstatSync(lockRoot);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Windows per-user lock root is not a real directory: ${lockRoot}`);
  }
  return lockRoot;
}

/**
 * Fixed lock root for the operating-system account. POSIX uses the numeric uid
 * under the sticky system /var/tmp directory, independent of HOME and TMPDIR.
 * The root is accepted only when it is a private real directory owned by uid.
 */
export function resolvePerUserLocksDir(): string {
  if (process.platform === 'win32') {
    return resolveWindowsLocksDir();
  }
  if (typeof process.getuid !== 'function') {
    return path.join(os.userInfo().homedir, '.myco', 'locks');
  }

  const uid = process.getuid();
  const lockRoot = path.join(path.sep, 'var', 'tmp', `myco-locks-${uid}`);
  try {
    fs.mkdirSync(lockRoot, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }

  const initial = fs.lstatSync(lockRoot);
  if (initial.isSymbolicLink() || !initial.isDirectory() || initial.uid !== uid) {
    throw new Error(`Per-user lock root is not a directory owned by uid ${uid}: ${lockRoot}`);
  }
  fs.chmodSync(lockRoot, 0o700);
  const verified = fs.lstatSync(lockRoot);
  if (verified.isSymbolicLink() || !verified.isDirectory()
    || verified.uid !== uid || (verified.mode & 0o777) !== 0o700) {
    throw new Error(`Per-user lock root is not private: ${lockRoot}`);
  }
  return lockRoot;
}
