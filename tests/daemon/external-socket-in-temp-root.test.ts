/**
 * A daemon a test starts binds its external-MCP socket under the sandbox home
 * the test preload made inside the run's temp root, as long as that path fits
 * the socket-path limit; past it, production falls back to a socket under
 * /tmp, outside the root, where the run cannot remove it. The run root's and
 * the sandbox home's names are kept short so the home-based path fits.
 */
import { describe, expect, it } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { resolveExternalMcpSocketPath } from '@myco/daemon/external-listener.js';

describe('the external-MCP socket of a test daemon', () => {
  it('resolves under the sandbox home, inside the temp directory', () => {
    const socket = resolveExternalMcpSocketPath(path.join(os.tmpdir(), 'myco-home'));
    expect({ socket, underHome: socket.startsWith(`${os.homedir()}${path.sep}`), underTmpdir: socket.startsWith(`${os.tmpdir()}${path.sep}`) })
      .toEqual({ socket, underHome: true, underTmpdir: true });
  });
});
