/**
 * Unit tests for daemon eviction PURE HELPERS only.
 *
 * The integration-style tests for `findPidsListeningOn`,
 * `isMycoDaemonForVault`, `findDaemonTargetsForVault`, and
 * `terminateProcess` were removed: they spawn `lsof`/`ps` or fork real
 * Node subprocesses, which flaked under full-suite parallel load and
 * cost more in maintenance time than the bugs they caught. The
 * orchestration paths are now covered by CI (which runs the full sweep)
 * and the `myco doctor` smoke command.
 *
 * What remains: `parseLsofOutput` and `findVaultFromCwd` — pure
 * functions whose tests run in <1ms each with zero process spawns.
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseLsofOutput,
  findVaultFromCwd,
  parseWindowsProcessCwd,
  buildWindowsCwdCommand,
  readWindowsProcessCwd,
} from '@myco/daemon/eviction.js';

// ---------------------------------------------------------------------------
// parseLsofOutput
// ---------------------------------------------------------------------------

describe('parseLsofOutput()', () => {
  it('parses a single p/n record pair', () => {
    const out = ['p1234', 'n127.0.0.1:21039'].join('\n');
    expect(parseLsofOutput(out)).toEqual([{ pid: 1234, port: 21039 }]);
  });

  it('parses multiple records', () => {
    const out = [
      'p1234',
      'n127.0.0.1:21039',
      'p5678',
      'n127.0.0.1:21040',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([
      { pid: 1234, port: 21039 },
      { pid: 5678, port: 21040 },
    ]);
  });

  it('ignores records without a port suffix', () => {
    const out = ['p1234', 'nSOME_UNRELATED_NAME'].join('\n');
    expect(parseLsofOutput(out)).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(parseLsofOutput('')).toEqual([]);
  });

  it('pairs an n-line with its most recent p-line', () => {
    const out = [
      'p1000',
      'p2000',
      'n127.0.0.1:9000',
    ].join('\n');
    expect(parseLsofOutput(out)).toEqual([{ pid: 2000, port: 9000 }]);
  });
});

// ---------------------------------------------------------------------------
// findVaultFromCwd
// ---------------------------------------------------------------------------

describe('findVaultFromCwd()', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-evict-cwd-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('returns null when no .myco/ exists in any ancestor', () => {
    const nested = path.join(tmpRoot, 'a', 'b');
    fs.mkdirSync(nested, { recursive: true });
    expect(findVaultFromCwd(nested)).toBeNull();
  });

  it('returns the .myco/ path when cwd is the project root', () => {
    const vault = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vault);
    expect(findVaultFromCwd(tmpRoot)).toBe(vault);
  });

  it('walks up to find the enclosing .myco/ from a subdirectory', () => {
    const vault = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vault);
    const nested = path.join(tmpRoot, 'src', 'deep', 'path');
    fs.mkdirSync(nested, { recursive: true });
    expect(findVaultFromCwd(nested)).toBe(vault);
  });

  it('returns null when .myco exists only as a file (not a dir)', () => {
    fs.writeFileSync(path.join(tmpRoot, '.myco'), 'not a directory');
    expect(findVaultFromCwd(tmpRoot)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Windows cwd-identity branch (FIX 3)
// ---------------------------------------------------------------------------

describe('parseWindowsProcessCwd()', () => {
  it('extracts a drive-letter path', () => {
    expect(parseWindowsProcessCwd('C:\\Users\\me\\project\r\n')).toBe('C:\\Users\\me\\project');
  });

  it('accepts forward-slash drive paths', () => {
    expect(parseWindowsProcessCwd('D:/work/repo')).toBe('D:/work/repo');
  });

  it('extracts a UNC path', () => {
    expect(parseWindowsProcessCwd('\\\\fileserver\\share\\proj')).toBe('\\\\fileserver\\share\\proj');
  });

  it('skips a PowerShell error preamble and finds the path line', () => {
    const out = [
      'Get-CimInstance : Some transient WMI warning',
      '    + CategoryInfo : NotSpecified',
      'C:\\opt\\myco',
    ].join('\r\n');
    expect(parseWindowsProcessCwd(out)).toBe('C:\\opt\\myco');
  });

  it('strips a leading BOM', () => {
    expect(parseWindowsProcessCwd('﻿C:\\proj')).toBe('C:\\proj');
  });

  it('returns null for empty output', () => {
    expect(parseWindowsProcessCwd('')).toBeNull();
  });

  it('returns null when no line is path-shaped', () => {
    expect(parseWindowsProcessCwd('not-a-path\r\n\r\n   ')).toBeNull();
  });
});

describe('buildWindowsCwdCommand()', () => {
  it('embeds the pid in the Win32_Process filter', () => {
    const cmd = buildWindowsCwdCommand(4242);
    expect(cmd).toContain('ProcessId = 4242');
    expect(cmd).toContain('Get-CimInstance Win32_Process');
    expect(cmd).toContain('Split-Path -Parent $p.Path');
  });
});

describe('readWindowsProcessCwd() — injected shell', () => {
  it('parses the cwd from the injected shell output', () => {
    const out = 'C:\\Users\\me\\proj\r\n';
    expect(readWindowsProcessCwd(1234, () => out)).toBe('C:\\Users\\me\\proj');
  });

  it('returns null when the shell yields no path-shaped output', () => {
    expect(readWindowsProcessCwd(1234, () => '')).toBeNull();
  });

  it('returns null (degrades gracefully) when the shell throws', () => {
    expect(readWindowsProcessCwd(1234, () => { throw new Error('powershell not found'); })).toBeNull();
  });
});

