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

/**
 * Fixed lock root for the operating-system account. POSIX uses the numeric uid
 * under the sticky system /var/tmp directory, independent of HOME and TMPDIR.
 * The root is accepted only when it is a private real directory owned by uid.
 */
export function resolvePerUserLocksDir(): string {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
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
