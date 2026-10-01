/**
 * The credential source is declared by the emitter and never inferred: a
 * `--credential registry` hook reads the registry entry for its root and
 * nothing else, even when a repository's settings relocate `MYCO_HOME` and set
 * the full env triplet; `--credential env` reads the triplet, all three or
 * none, or a join code when none of the three is set; every record's server
 * URL passes the one member rule: https, or http on this machine's loopback.
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

describe('the MCP bridge started outside the project', () => {
  it('resolves the one membership the home holds, says so, and never does this for a hook', () => {
    captureStderr();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-not-a-project-'));
    const root = path.join(mycoHome, 'the-project');
    fs.mkdirSync(root, { recursive: true });
    registerTestMember({ mycoHome, token: mintMemberToken(), projectId: 'proj_only', root });
    const bridge = resolveCredential('registry', { cwd: elsewhere, mycoHome, invokedBy: 'mcp' });
    expect(bridge?.projectId).toBe('proj_only');
    expect(stderrLines.join('')).toContain(`serving the one membership this machine holds (${root})`);
    // A hook in an unjoined directory finds nothing: its session must not land in another project.
    stderrLines.length = 0;
    expect(resolveCredential('registry', { cwd: elsewhere, mycoHome, invokedBy: 'hook stop' })).toBeNull();
    expect(stderrLines.join('')).toContain('no registry entry');
  });

  it('resolves nothing when the home holds two memberships, and says which directory to start in', () => {
    captureStderr();
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-not-a-project-'));
    for (const name of ['a', 'b']) {
      const root = path.join(mycoHome, name);
      fs.mkdirSync(root, { recursive: true });
      registerTestMember({ mycoHome, token: mintMemberToken(), projectId: `proj_${name}`, root });
    }
    expect(resolveCredential('registry', { cwd: elsewhere, mycoHome, invokedBy: 'mcp' })).toBeNull();
    expect(stderrLines.join('')).toContain('none of the 2 joined projects');
  });
});

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

  it('registry: an http entry off this machine\'s loopback is refused', () => {
    captureStderr();
    registerTestMember({ mycoHome, token: mintMemberToken(), projectId: 'proj_1', serverUrl: 'http://srv.example' });
    expect(resolveCredential('registry', { mycoHome })).toBeNull();
    expect(stderrLines.join('')).toContain("names a server that is not https, or http on this machine's loopback");
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
    expect(stderrLines.pop()).toContain("must be https, or http on this machine's loopback");
  });

  it('plain http is admitted on this machine\'s loopback only, by the registry and the env source alike', () => {
    captureStderr();
    const triplet = (url: string) => ({ [ENV_SERVER_URL]: url, [ENV_MEMBER_TOKEN]: 't', [ENV_PROJECT]: 'proj_env' });
    const loopback = ['http://127.0.0.1:18787', 'http://127.8.9.10:18787', 'http://localhost:8787', 'http://[::1]:8787'];
    const offMachine = ['http://127.0.0.1.example', 'http://10.0.0.5:8787', 'http://host.docker.internal:8787', 'http://[::2]:8787'];
    for (const url of loopback) {
      expect({ url, record: resolveCredential('env', { env: triplet(url) }) }).toEqual({ url, record: { serverUrl: url, token: 't', projectId: 'proj_env', source: 'env' } });
      registerTestMember({ mycoHome, token: mintMemberToken(), projectId: 'proj_1', serverUrl: url });
      expect({ url, served: resolveCredential('registry', { mycoHome })?.serverUrl }).toEqual({ url, served: url });
    }
    for (const url of offMachine) {
      expect({ url, record: resolveCredential('env', { env: triplet(url) }) }).toEqual({ url, record: null });
      expect(stderrLines.pop()).toContain("must be https, or http on this machine's loopback");
      registerTestMember({ mycoHome, token: mintMemberToken(), projectId: 'proj_1', serverUrl: url });
      expect({ url, record: resolveCredential('registry', { mycoHome }) }).toEqual({ url, record: null });
      expect(stderrLines.pop()).toContain("names a server that is not https, or http on this machine's loopback");
    }
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
    const result = await runHook('post-tool-use', { session_id: 'sess-relocated', tool_name: 'Read', tool_input: { file_path: '/a' } }, { fetch, credential: 'registry', symbiont: 'copilot' });
    expect(requests).toEqual([]);
    expect(result.stderr).toContain('no registry entry');
    expect(rig.rows('events')).toBe(0);
    // The same hooks declared `env` capture for the env URL, and the turn's end delivers there — the source is the
    // command's to declare. A credential from the environment ships in the hook that ends the turn, never before.
    const envRun = await runHook('post-tool-use', { session_id: 'sess-relocated', tool_name: 'Read', tool_input: { file_path: '/a' } }, { fetch, credential: 'env', symbiont: 'copilot' });
    expect(requests).toEqual([]);
    expect(envRun.stderr).not.toContain('no registry entry');
    await runHook('stop', { session_id: 'sess-relocated', last_assistant_message: 'done' }, { fetch, credential: 'env', symbiont: 'copilot' });
    expect(requests.map((r) => r.path)).toContain('/events');
  });
});
