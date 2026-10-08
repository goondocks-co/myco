/**
 * A runner's harness detection decides a login from a credential file's
 * metadata and never reads its bytes.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { detectHarnessesAsync } from '@myco/runner/detect.js';
import { credentialFile, HARNESSES } from '@myco/runner/harnesses.js';

describe('runner harness detection', () => {
  let root: string;
  let saved: NodeJS.ProcessEnv;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-runner-detect-'));
    saved = { ...process.env };
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /** A harness whose login is a credential file. */
  const fileHarness = HARNESSES.find((h) => h.credential.kind === 'file')!;

  /** A stub for the harness's binary on PATH, and a credential file holding content. */
  const stageLogin = (): string => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, fileHarness.binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.HOME = path.join(root, 'home');
    process.env.CODEX_HOME = path.join(root, 'home', '.codex');
    process.env.CLAUDE_CONFIG_DIR = path.join(root, 'home', '.claude');
    process.env.PATH = `${bin}:/usr/bin:/bin`;
    const credential = credentialFile(fileHarness)!;
    fs.mkdirSync(path.dirname(credential), { recursive: true });
    fs.writeFileSync(credential, '{"unrelated":"value"}');
    return credential;
  };

  const OWNER_NO_ACCESS = 0o000;

  it('decides a login from metadata alone: a credential file whose bytes cannot be read still counts', async () => {
    const credential = stageLogin();
    fs.chmodSync(credential, OWNER_NO_ACCESS);
    const found = await detectHarnessesAsync([fileHarness.id], undefined, { credentialBytes: false });
    expect(found).toEqual([{ id: fileHarness.id, installed: true, authenticated: true }]);
  });

  it('reads the credential file in the default mode, which an unreadable file shows', async () => {
    const credential = stageLogin();
    fs.chmodSync(credential, OWNER_NO_ACCESS);
    const found = await detectHarnessesAsync([fileHarness.id]);
    expect(found).toEqual([{ id: fileHarness.id, installed: true, authenticated: false }]);
  });

  it('takes an empty or absent credential file as logged out', async () => {
    const credential = stageLogin();
    const mode = { credentialBytes: false };
    fs.writeFileSync(credential, '');
    expect((await detectHarnessesAsync([fileHarness.id], undefined, mode))[0]).toMatchObject({ authenticated: false });
    fs.rmSync(credential);
    expect((await detectHarnessesAsync([fileHarness.id], undefined, mode))[0]).toMatchObject({ authenticated: false });
  });
});
