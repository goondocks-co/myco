import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  findVaultFromCommandLine,
  parseLinuxListenerOutput,
  parseLsofOutput,
  parseWindowsTcpConnections,
} from '@myco-hub/process.js';

describe('myco-hub process discovery helpers', () => {
  let tmpRoot: string;
  let vaultDir: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hub-process-'));
    vaultDir = path.join(tmpRoot, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('parses lsof listener field output', () => {
    const out = [
      'p1234',
      'n127.0.0.1:21039',
      'p5678',
      'n127.0.0.1:28221',
    ].join('\n');

    expect(parseLsofOutput(out)).toEqual([
      { pid: 1234, port: 21039 },
      { pid: 5678, port: 28221 },
    ]);
  });

  it('parses Windows Get-NetTCPConnection JSON output', () => {
    const out = JSON.stringify([
      { LocalPort: 21039, OwningProcess: 1234 },
      { LocalPort: 28221, OwningProcess: 5678 },
    ]);

    expect(parseWindowsTcpConnections(out)).toEqual([
      { pid: 1234, port: 21039 },
      { pid: 5678, port: 28221 },
    ]);
  });

  it('parses single-row Windows listener JSON output', () => {
    const out = JSON.stringify({ LocalPort: 21039, OwningProcess: 1234 });

    expect(parseWindowsTcpConnections(out)).toEqual([{ pid: 1234, port: 21039 }]);
  });

  it('parses Linux ss listener output', () => {
    const out = 'LISTEN 0 4096 127.0.0.1:21039 0.0.0.0:* users:(("node",pid=1234,fd=23))';

    expect(parseLinuxListenerOutput(out)).toEqual([{ pid: 1234, port: 21039 }]);
  });

  it('parses Linux netstat listener output', () => {
    const out = 'tcp 0 0 127.0.0.1:28221 0.0.0.0:* LISTEN 5678/node';

    expect(parseLinuxListenerOutput(out)).toEqual([{ pid: 5678, port: 28221 }]);
  });

  it('resolves a quoted --vault command-line argument', () => {
    const commandLine = `node myco daemon --vault "${vaultDir}"`;

    expect(findVaultFromCommandLine(commandLine)).toBe(vaultDir);
  });

  it('resolves a --vault= command-line argument', () => {
    const commandLine = `myco daemon --vault=${vaultDir}`;

    expect(findVaultFromCommandLine(commandLine)).toBe(vaultDir);
  });
});
