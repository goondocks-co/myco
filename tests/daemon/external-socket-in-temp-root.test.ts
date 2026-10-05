/**
 * A daemon a test starts binds its external-MCP socket under the sandbox home
 * the test preload made inside the run's temp root, as long as that path fits
 * the socket-path limit; past it, production falls back to a socket under
 * /tmp, outside the root, where the run cannot remove it. The run root's and
 * the sandbox home's names are kept short so the home-based path fits even
 * under macOS's per-user temp directory, the longest parent a run meets.
 */
import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveExternalMcpSocketPath } from '@myco/daemon/external-listener.js';

/** macOS's per-user temp directory, `/var/folders/<2>/<30>/T`: 48 bytes for every account. */
const MACOS_USER_TEMP_DIR = `/var/folders/xx/${'x'.repeat(30)}/T`;

/** The temp directory the run started from: the run root's parent under the runner, os.tmpdir() under a raw `bun test`. */
const RUN_PARENT_TEMP_DIR = fs.realpathSync(process.env.MYCO_TEST_RUN_PARENT_TMPDIR ?? os.tmpdir());

describe('the external-MCP socket of a test daemon', () => {
  it('resolves under the sandbox home, with the run under macOS\'s per-user temp directory', () => {
    const home = os.homedir();
    const worstHome = path.posix.join(MACOS_USER_TEMP_DIR, path.relative(RUN_PARENT_TEMP_DIR, home).split(path.sep).join('/'));
    const setHome = (value: () => string) => { (os as { homedir: () => string }).homedir = value; };
    const realHomedir = os.homedir;
    setHome(() => worstHome);
    try {
      const socket = resolveExternalMcpSocketPath(path.join(worstHome, 'myco-home'));
      expect({ socket, underHome: socket.startsWith(`${worstHome}/`) }).toEqual({ socket, underHome: true });
    } finally {
      setHome(realHomedir);
    }
  });
});
