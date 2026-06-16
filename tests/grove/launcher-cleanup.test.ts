import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GLOBAL_HOOK_LAUNCHER_FILENAME,
  GLOBAL_MCP_LAUNCHER_FILENAME,
  removeRetiredGlobalLaunchers,
} from '@myco/grove/launcher-cleanup.js';

describe('removeRetiredGlobalLaunchers', () => {
  let mycoHome: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-cleanup-'));
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('deletes both retired launcher files when present', () => {
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    const mcpLauncherPath = path.join(mycoHome, GLOBAL_MCP_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n');
    fs.writeFileSync(mcpLauncherPath, '// stale mcp launcher\n');

    const report = removeRetiredGlobalLaunchers(mycoHome);

    expect(report.removed).toEqual([launcherPath, mcpLauncherPath]);
    expect(fs.existsSync(launcherPath)).toBe(false);
    expect(fs.existsSync(mcpLauncherPath)).toBe(false);
  });

  it('removes only the launcher file that is present, leaving the report accurate', () => {
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n');

    const report = removeRetiredGlobalLaunchers(mycoHome);

    expect(report.removed).toEqual([launcherPath]);
    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it('is a no-op when neither launcher file exists', () => {
    const report = removeRetiredGlobalLaunchers(mycoHome);
    expect(report.removed).toEqual([]);
  });

  it('is idempotent — a second cleanup pass removes nothing', () => {
    fs.writeFileSync(path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME), '// stale\n');
    fs.writeFileSync(path.join(mycoHome, GLOBAL_MCP_LAUNCHER_FILENAME), '// stale\n');

    removeRetiredGlobalLaunchers(mycoHome);
    const second = removeRetiredGlobalLaunchers(mycoHome);

    expect(second.removed).toEqual([]);
  });
});
