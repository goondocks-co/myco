/**
 * Doctor "Intelligence" auth evidence for harness Claude CLI runs.
 *
 * Background runs spawn the CLI under the isolated agent-sessions
 * CLAUDE_CONFIG_DIR, which does not share the user's interactive login —
 * the check must therefore refuse to treat "this machine is logged in" as
 * evidence, and pass only on one of the three real credential sources.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkClaudeHeadlessAuth } from '@myco/cli/doctor';
import { HARNESS_SESSION_DIRNAME } from '@myco/agent/harness/redirect-epoch.js';
import { vi } from '../helpers/vi-shim.js';

describe('checkClaudeHeadlessAuth', () => {
  let tmpHome: string;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-doctor-auth-'));
    vi.stubEnv('MYCO_HOME', tmpHome);
    // Blank = absent for the truthy env check; also shields the test from a
    // developer machine that has the real token exported.
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', '');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(tmpHome, { recursive: true, force: true });
  });

  it('fails with the setup-token remediation when no credential source exists', async () => {
    const check = await checkClaudeHeadlessAuth('anthropic');
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('claude setup-token');
    expect(check.detail).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(check.detail).toContain(path.join(tmpHome, 'secrets.env'));
  });

  it('passes when CLAUDE_CODE_OAUTH_TOKEN is set in the environment', async () => {
    vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat01-test');
    const check = await checkClaudeHeadlessAuth('anthropic');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('env');
  });

  it('passes when the token is stored in machine secrets.env', async () => {
    fs.writeFileSync(path.join(tmpHome, 'secrets.env'), 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n', { mode: 0o600 });
    const check = await checkClaudeHeadlessAuth('anthropic');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('secrets.env');
  });

  it('passes when credentials are provisioned inside the agent-sessions dir', async () => {
    const sessionDir = path.join(tmpHome, HARNESS_SESSION_DIRNAME);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(path.join(sessionDir, '.credentials.json'), '{}', { mode: 0o600 });
    const check = await checkClaudeHeadlessAuth('anthropic');
    expect(check.status).toBe('ok');
    expect(check.detail).toContain('agent-sessions');
  });
});
