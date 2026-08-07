/**
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

import { describe, expect, test } from 'bun:test';
import { terminateDaemonProcess } from '@myco/service/daemon-termination.js';

describe('terminateDaemonProcess', () => {
  test.each(['SIGTERM', 'SIGKILL'] as const)(
    'contains external MCP before Windows %s',
    async (signal) => {
      const lifecycle: string[] = [];

      await terminateDaemonProcess(4242, signal, {
        platform: 'win32',
        withExternalMcpContainment: async (terminate) => {
          lifecycle.push('contain:start');
          await terminate();
          lifecycle.push('contain:end');
        },
        kill: (pid, sentSignal) => {
          lifecycle.push(`kill:${pid}:${sentSignal}`);
        },
        // Stubbed so the case stays hermetic. Left out, the Windows arm runs the
        // REAL waiter against pid 4242 — an arbitrary number that is a live
        // unrelated process on some machines and free on others, so the case
        // polled for its full 10s timeout here and passed instantly elsewhere.
        confirmTermination: async (pid) => {
          lifecycle.push(`confirm:${pid}`);
        },
      });

      expect(lifecycle).toEqual([
        'contain:start',
        `kill:4242:${signal}`,
        `confirm:4242`,
        'contain:end',
      ]);
    },
  );

  test('suppresses Windows termination when containment fails', async () => {
    let killCalls = 0;

    await expect(terminateDaemonProcess(4242, 'SIGTERM', {
      platform: 'win32',
      withExternalMcpContainment: async () => {
        throw new Error('containment failed');
      },
      kill: () => {
        killCalls += 1;
      },
    })).rejects.toThrow(/containment failed/);

    expect(killCalls).toBe(0);
  });

  test('keeps Windows containment held until process exit is confirmed', async () => {
    const lifecycle: string[] = [];

    await terminateDaemonProcess(4242, 'SIGTERM', {
      platform: 'win32',
      withExternalMcpContainment: async (terminate) => {
        lifecycle.push('contain:start');
        await terminate();
        lifecycle.push('contain:end');
      },
      kill: () => {
        lifecycle.push('kill');
      },
      confirmTermination: async (pid) => {
        lifecycle.push(`confirm:${pid}`);
      },
    });

    expect(lifecycle).toEqual([
      'contain:start',
      'kill',
      'confirm:4242',
      'contain:end',
    ]);
  });

  test('uses catchable POSIX signals without the Windows hard-kill guard', async () => {
    const lifecycle: string[] = [];

    await terminateDaemonProcess(4242, 'SIGTERM', {
      platform: 'darwin',
      withExternalMcpContainment: async () => {
        lifecycle.push('contain');
      },
      kill: () => {
        lifecycle.push('kill');
      },
    });

    expect(lifecycle).toEqual(['kill']);
  });
});
