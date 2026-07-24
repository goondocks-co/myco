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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveWindowsLockRootFromProfile,
} from '@myco/utils/user-lock-root.js';

const HELPER = path.resolve('tests/helpers/user-lock-root-helper.ts');

function runHelper(env: NodeJS.ProcessEnv): Promise<string> {
  const child = spawn(process.execPath, ['run', HELPER], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout!.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf-8'); });
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code !== 0) return reject(new Error(`user-lock-root helper exited ${code}: ${stderr}`));
      resolve((JSON.parse(stdout) as { lockRoot: string }).lockRoot);
    });
  });
}

describe('Windows per-user lock root', () => {
  it('builds the existing .myco lock location from a native profile path', () => {
    expect(resolveWindowsLockRootFromProfile('D:\\Profiles\\Chris'))
      .toBe('D:\\Profiles\\Chris\\.myco\\locks');
    expect(() => resolveWindowsLockRootFromProfile('relative\\profile')).toThrow();
    expect(() => resolveWindowsLockRootFromProfile('')).toThrow();
  });

  it.skipIf(process.platform !== 'win32')(
    'is identical across processes with divergent home-related environments',
    async () => {
      const firstHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-win-home-a-'));
      const secondHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-win-home-b-'));
      try {
        const base = { ...process.env, MYCO_HOME: 'C:\\Explicit\\SharedMycoHome' };
        const [first, second] = await Promise.all([
          runHelper({
            ...base,
            HOME: firstHome,
            USERPROFILE: firstHome,
            LOCALAPPDATA: path.join(firstHome, 'AppData', 'Local'),
          }),
          runHelper({
            ...base,
            HOME: secondHome,
            USERPROFILE: secondHome,
            LOCALAPPDATA: path.join(secondHome, 'AppData', 'Local'),
          }),
        ]);

        expect(first).toBe(second);
        expect(first.toLowerCase().endsWith('\\.myco\\locks')).toBe(true);
      } finally {
        fs.rmSync(firstHome, { recursive: true, force: true });
        fs.rmSync(secondHome, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
