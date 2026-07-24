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

import { describe, expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { stringify } from 'smol-toml';
import {
  ExternalMcpContainmentError,
  clearExternalMcpContainmentIntent,
  externalMcpContainmentIntentPath,
  readExternalMcpContainmentIntent,
  writeExternalMcpContainmentIntent,
  type ExternalMcpContainmentIntent,
} from '@myco/daemon/external-mcp-containment.js';

function stateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'myco-external-mcp-containment-'));
}

function intent(
  overrides: Partial<ExternalMcpContainmentIntent> = {},
): ExternalMcpContainmentIntent {
  return {
    version: 1,
    operation: 'retire',
    from: { enabled: true, port: 8743 },
    to: { enabled: false, port: 8743 },
    ports: [8743],
    phase: 'funnel_off_pending',
    requested_at: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

describe('external MCP containment intent', () => {
  test.skipIf(process.platform === 'win32')(
    'durably publishes and durably clears the intent',
    () => {
      const dir = stateDir();
      const intentPath = externalMcpContainmentIntentPath(dir);
      const events: string[] = [];
      const fdPaths = new Map<number, string>();
      const originalOpen = fs.openSync.bind(fs);
      const originalFsync = fs.fsyncSync.bind(fs);
      const originalRename = fs.renameSync.bind(fs);
      const openSpy = spyOn(fs, 'openSync').mockImplementation(
        ((target: fs.PathLike, flags: fs.OpenMode, mode?: fs.Mode) => {
          const fd = originalOpen(target, flags, mode);
          fdPaths.set(fd, String(target));
          return fd;
        }) as typeof fs.openSync,
      );
      const fsyncSpy = spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
        events.push(`fsync:${fdPaths.get(fd) ?? 'unknown'}`);
        originalFsync(fd);
      });
      const renameSpy = spyOn(fs, 'renameSync').mockImplementation((source, destination) => {
        events.push(`rename:${String(source)}:${String(destination)}`);
        originalRename(source, destination);
      });

      try {
        writeExternalMcpContainmentIntent(dir, intent());
        clearExternalMcpContainmentIntent(dir);
      } finally {
        renameSpy.mockRestore();
        fsyncSpy.mockRestore();
        openSpy.mockRestore();
      }

      const publishIndex = events.findIndex((event) => event.endsWith(`:${intentPath}`));
      const publishSyncIndex = events.findIndex(
        (event, index) => index > publishIndex && event === `fsync:${dir}`,
      );
      const removalIndex = events.findIndex(
        (event, index) => index > publishSyncIndex && event.startsWith(`rename:${intentPath}:`),
      );
      expect(publishIndex).toBeGreaterThanOrEqual(0);
      expect(publishSyncIndex).toBeGreaterThan(publishIndex);
      expect(removalIndex).toBeGreaterThan(publishSyncIndex);
      expect(events.findIndex(
        (event, index) => index > removalIndex && event === `fsync:${dir}`,
      )).toBeGreaterThan(removalIndex);
    },
  );

  test('publishes a canonical owner-only intent and reads it back', () => {
    const dir = stateDir();

    writeExternalMcpContainmentIntent(dir, intent({
      ports: [9000, 8743, 9000],
    }));

    const intentPath = externalMcpContainmentIntentPath(dir);
    expect(fs.existsSync(intentPath)).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(intentPath).mode & 0o777).toBe(0o600);
    }
    expect(readExternalMcpContainmentIntent(dir)).toEqual(intent({
      ports: [8743, 9000],
    }));
  });

  test('absence is the only state read as no intent', () => {
    expect(readExternalMcpContainmentIntent(stateDir())).toBeUndefined();
  });

  test.each([
    ['malformed TOML', 'version = [\n'],
    ['unsupported version', stringify({
      ...intent(),
      version: 2,
    } as unknown as Record<string, unknown>)],
    ['invalid operation', stringify({
      ...intent(),
      operation: 'enable',
    } as unknown as Record<string, unknown>)],
    ['invalid phase', stringify({
      ...intent(),
      phase: 'complete',
    } as unknown as Record<string, unknown>)],
    ['invalid source state', stringify({
      ...intent(),
      from: { enabled: 'yes', port: 8743 },
    } as unknown as Record<string, unknown>)],
    ['enabled target', stringify({
      ...intent(),
      to: { enabled: true, port: 8743 },
    } as unknown as Record<string, unknown>)],
    ['non-integer port', stringify({
      ...intent(),
      ports: [8743.5],
    } as unknown as Record<string, unknown>)],
    ['out-of-range port', stringify({
      ...intent(),
      ports: [1023],
    } as unknown as Record<string, unknown>)],
    ['empty ports', stringify({
      ...intent(),
      ports: [],
    } as unknown as Record<string, unknown>)],
    ['invalid timestamp', stringify({
      ...intent(),
      requested_at: 'not-a-timestamp',
    } as unknown as Record<string, unknown>)],
  ])('rejects %s and preserves the file', (_label, content) => {
    const dir = stateDir();
    const intentPath = externalMcpContainmentIntentPath(dir);
    fs.writeFileSync(intentPath, content);

    expect(() => readExternalMcpContainmentIntent(dir))
      .toThrow(ExternalMcpContainmentError);
    expect(fs.readFileSync(intentPath, 'utf-8')).toBe(content);
  });

  test.skipIf(process.platform === 'win32')(
    'rejects symlinks, directories, and special files without replacing them',
    () => {
      const cases: Array<{
        name: string;
        prepare: (target: string) => void;
        verify: (target: string) => boolean;
      }> = [
        {
          name: 'symlink',
          prepare: (target) => {
            const source = `${target}.source`;
            fs.writeFileSync(source, stringify(intent() as unknown as Record<string, unknown>));
            fs.symlinkSync(source, target);
          },
          verify: (target) => fs.lstatSync(target).isSymbolicLink(),
        },
        {
          name: 'directory',
          prepare: (target) => fs.mkdirSync(target),
          verify: (target) => fs.lstatSync(target).isDirectory(),
        },
        {
          name: 'FIFO',
          prepare: (target) => {
            const result = spawnSync('mkfifo', [target], { encoding: 'utf-8' });
            expect(result.status).toBe(0);
          },
          verify: (target) => fs.lstatSync(target).isFIFO(),
        },
      ];

      for (const entry of cases) {
        const dir = stateDir();
        const intentPath = externalMcpContainmentIntentPath(dir);
        entry.prepare(intentPath);

        expect(() => readExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(() => writeExternalMcpContainmentIntent(dir, intent()))
          .toThrow(ExternalMcpContainmentError);
        expect(() => clearExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(entry.verify(intentPath)).toBe(true);
      }
    },
  );

  test.skipIf(process.platform === 'win32')(
    'rejects a socket without replacing it',
    async () => {
      const dir = stateDir();
      const intentPath = externalMcpContainmentIntentPath(dir);
      const server = net.createServer();
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(intentPath, resolve);
      });

      try {
        expect(() => readExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(() => writeExternalMcpContainmentIntent(dir, intent()))
          .toThrow(ExternalMcpContainmentError);
        expect(() => clearExternalMcpContainmentIntent(dir))
          .toThrow(ExternalMcpContainmentError);
        expect(fs.lstatSync(intentPath).isSocket()).toBe(true);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  test('clears only when explicitly requested', () => {
    const dir = stateDir();
    writeExternalMcpContainmentIntent(dir, intent());
    const intentPath = externalMcpContainmentIntentPath(dir);

    expect(readExternalMcpContainmentIntent(dir)).toEqual(intent());
    expect(fs.existsSync(intentPath)).toBe(true);

    clearExternalMcpContainmentIntent(dir);
    expect(fs.existsSync(intentPath)).toBe(false);
    clearExternalMcpContainmentIntent(dir);
  });
});
