/**
 * The credential source is declared by the emitter and never inferred: a
 * `--credential registry` hook reads the registry entry for its root and
 * nothing else, even when a repository's settings relocate `MYCO_HOME` and set
 * the full env triplet; `--credential env` reads the triplet, all three or
 * none; every record must be https.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ENV_MEMBER_TOKEN, ENV_PROJECT, ENV_SERVER_URL, parseCredentialFlag, resolveCredential, resolveMemberProjectRoot } from '@myco/member/credential.js';
import { mintMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberRig, tempMycoHome } from './helpers/server.js';
import { registerTestMember, recordingFetch, runHook } from './helpers/hooks.js';

const ENV_KEYS = ['MYCO_HOME', ENV_SERVER_URL, ENV_MEMBER_TOKEN, ENV_PROJECT] as const;
const saved: Record<string, string | undefined> = {};
let mycoHome: string;
const stderrLines: string[] = [];
const origErr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  for (const k of ENV_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  stderrLines.length = 0;
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  (process.stderr as unknown as { write: unknown }).write = origErr;
});

const captureStderr = () => {
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = ((c: unknown) => { stderrLines.push(String(c)); return true; }) as never;
};

describe('credential source', () => {
  it('parses the declared source from the hook command and refuses unknown values', () => {
    expect(parseCredentialFlag(['hook', 'stop', '--credential', 'registry'])).toBe('registry');
    expect(parseCredentialFlag(['hook', 'stop', '--credential=env'])).toBe('env');
    expect(parseCredentialFlag(['hook', 'stop'])).toBeNull();
    expect(parseCredentialFlag(['hook', 'stop', '--credential', 'file'])).toBeNull();
  });

  it('an undeclared source captures nothing, with one stderr line', () => {
    captureStderr();
    expect(resolveCredential(null, { mycoHome })).toBeNull();
    expect(stderrLines.join('')).toContain('--credential registry|env');
  });

  it('registry: the entry for the resolved root, and nothing when absent', () => {
    captureStderr();
    expect(resolveCredential('registry', { mycoHome })).toBeNull();
    expect(stderrLines.join('')).toContain('no registry entry');
    const token = mintMemberToken();
    registerTestMember({ mycoHome, token, tokenId: 'mt_x', projectId: 'proj_1', serverUrl: 'https://srv.example', expiresAt: 42 });
    expect(resolveCredential('registry', { mycoHome })).toEqual({
      serverUrl: 'https://srv.example', token, tokenId: 'mt_x', projectId: 'proj_1', expiresAt: 42, refreshAfter: undefined, source: 'registry', root: resolveMemberProjectRoot(process.cwd()),
    });
  });

  it('registry: an http entry is refused', () => {
    captureStderr();
    registerTestMember({ mycoHome, token: mintMemberToken(), projectId: 'proj_1', serverUrl: 'http://srv.example' });
    expect(resolveCredential('registry', { mycoHome })).toBeNull();
    expect(stderrLines.join('')).toContain('non-https');
  });

  it('env: the triplet all three or none, https required', () => {
    captureStderr();
    const env = { [ENV_SERVER_URL]: 'https://env.example', [ENV_MEMBER_TOKEN]: 't', [ENV_PROJECT]: 'proj_env' };
    expect(resolveCredential('env', { env })).toEqual({ serverUrl: 'https://env.example', token: 't', projectId: 'proj_env', source: 'env' });
    expect(resolveCredential('env', { env: {} })).toBeNull();
    expect(stderrLines.pop()).toContain('are not set');
    expect(resolveCredential('env', { env: { [ENV_SERVER_URL]: 'https://env.example', [ENV_PROJECT]: 'p' } })).toBeNull();
    expect(stderrLines.pop()).toContain('all three or none');
    expect(resolveCredential('env', { env: { ...env, [ENV_SERVER_URL]: 'http://env.example' } })).toBeNull();
    expect(stderrLines.pop()).toContain('must be https');
  });

  it('a --credential registry hook under a repo-settings MYCO_HOME relocation plus the env triplet sends nothing to the env URL', async () => {
    // The repository's settings block relocates MYCO_HOME to an empty dir and
    // sets the triplet; the installer-emitted command still declares registry.
    const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-relocated-'));
    process.env.MYCO_HOME = emptyHome;
    process.env[ENV_SERVER_URL] = 'https://attacker.example';
    process.env[ENV_MEMBER_TOKEN] = mintMemberToken();
    process.env[ENV_PROJECT] = 'proj_1';
    const rig = await memberRig();
    const { fetch, requests } = recordingFetch(rig.fetch);
    const result = await runHook('post-tool-use', { session_id: 'sess-relocated', tool_name: 'Read', tool_input: { file_path: '/a' } }, { fetch, credential: 'registry' });
    expect(requests).toEqual([]);
    expect(result.stderr).toContain('no registry entry');
    expect(rig.rows('events')).toBe(0);
    // The same hook declared `env` would dial the env URL — the source is the command's to declare.
    const envRun = await runHook('post-tool-use', { session_id: 'sess-relocated', tool_name: 'Read', tool_input: { file_path: '/a' } }, { fetch, credential: 'env' });
    expect(requests.map((r) => r.path)).toEqual(['/events']);
    expect(envRun.stderr).not.toContain('no registry entry');
  });
});
