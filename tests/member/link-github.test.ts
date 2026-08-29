/**
 * `myco member link-github`: mints a one-time link for this root's membership
 * and prints the URL. The key rides the URL fragment; the request body is `{}`;
 * the browser opener runs only on request.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { resetMachineIdCache } from '@myco/machine-id.js';
import { linkUrl, runLinkGithub } from '@myco/cli/member.js';
import { classifyLinkAnswer, type FetchLike } from '@myco/member/transport.js';
import { ENV_MEMBER_TOKEN, resolveMemberProjectRoot } from '@myco/member/credential.js';
import { tempMycoHome } from './helpers/server.js';
import { recordingFetch, registerTestMember } from './helpers/hooks.js';

const SERVER_URL = 'https://member-test.invalid';
const KEY = 'k'.repeat(43);

let mycoHome: string;
let root: string;
const savedHome = process.env.MYCO_HOME;
const savedToken = process.env[ENV_MEMBER_TOKEN];

beforeEach(() => {
  mycoHome = tempMycoHome();
  process.env.MYCO_HOME = mycoHome;
  delete process.env[ENV_MEMBER_TOKEN];
  resetMachineIdCache();
  root = resolveMemberProjectRoot(process.cwd());
});
afterEach(() => {
  process.env.MYCO_HOME = savedHome;
  if (savedToken === undefined) delete process.env[ENV_MEMBER_TOKEN]; else process.env[ENV_MEMBER_TOKEN] = savedToken;
  resetMachineIdCache();
});

const answering = (body: unknown, status = 200): FetchLike => async () => Response.json(body, { status });

describe('myco member link-github', () => {
  it('prints the link once, sends an empty body with the credential, and does not open a browser unless asked', async () => {
    registerTestMember({ mycoHome, token: 'mt_' + 'a'.repeat(40), projectId: 'proj_1', serverUrl: SERVER_URL, root });
    const { fetch, requests } = recordingFetch(answering({ persisted: true, key: KEY, expiresAt: 5 }));
    const out: string[] = [];
    const opened: string[] = [];
    const url = await runLinkGithub([], { mycoHome, cwd: root, fetch, stdout: (l) => out.push(l), stderr: () => {}, openBrowser: (u) => opened.push(u) });

    expect(url).toBe(`${SERVER_URL}/link#${KEY}`);
    expect(out.filter((l) => l.includes(KEY))).toEqual([url]);
    expect(opened).toEqual([]);
    expect(requests).toHaveLength(1);
    expect({ method: requests[0]!.method, path: requests[0]!.path, body: requests[0]!.body }).toEqual({ method: 'POST', path: '/members/link-github', body: '{}' });
    expect(requests[0]!.headers.authorization).toMatch(/^Bearer mt_/);
  });

  it('hands the link to the browser with --open', async () => {
    registerTestMember({ mycoHome, token: 'mt_' + 'a'.repeat(40), projectId: 'proj_1', serverUrl: SERVER_URL, root });
    const opened: string[] = [];
    await runLinkGithub(['--open'], { mycoHome, cwd: root, fetch: answering({ persisted: true, key: KEY, expiresAt: 5 }), stdout: () => {}, stderr: () => {}, openBrowser: (u) => opened.push(u) });
    expect(opened).toEqual([linkUrl(SERVER_URL, KEY)]);
  });

  it('refuses a root with no registry entry, naming the remedy, and never calls the server', async () => {
    const { fetch, requests } = recordingFetch(answering({ persisted: true, key: KEY, expiresAt: 5 }));
    const errs: string[] = [];
    const url = await runLinkGithub([], { mycoHome, cwd: root, fetch, stdout: () => {}, stderr: (l) => errs.push(l) });
    expect(url).toBeNull();
    expect(errs.join('\n')).toContain('no registry entry');
    expect(requests).toHaveLength(0);
    process.exitCode = 0;
  });

  it('reports a refused credential and an unknown option without quoting any value', async () => {
    registerTestMember({ mycoHome, token: 'mt_' + 'a'.repeat(40), projectId: 'proj_1', serverUrl: SERVER_URL, root });
    const errs: string[] = [];
    expect(await runLinkGithub([], { mycoHome, cwd: root, fetch: answering({}, 401), stdout: () => {}, stderr: (l) => errs.push(l) })).toBeNull();
    expect(errs.join('\n')).toContain('refused this credential');
    expect(await runLinkGithub(['--bogus=secret'], { mycoHome, cwd: root, fetch: answering({}), stdout: () => {}, stderr: (l) => errs.push(l) })).toBeNull();
    expect(errs.join('\n')).toContain('unknown option --bogus');
    expect(errs.join('\n')).not.toContain('secret');
    process.exitCode = 0;
  });
});

describe('classifyLinkAnswer', () => {
  it('classifies the shapes the route answers', () => {
    const response = (json: Record<string, unknown> | null, status = 200) => ({ kind: 'response' as const, status, protocolHeader: true, json });
    expect(classifyLinkAnswer(response({ persisted: true, key: KEY, expiresAt: 5 }))).toEqual({ class: 'linked', key: KEY, expiresAt: 5 });
    expect(classifyLinkAnswer(response({ persisted: false, code: 'unknown_field', reason: 'x' }))).toEqual({ class: 'refused', code: 'unknown_field', reason: 'x' });
    expect(classifyLinkAnswer(response(null))).toMatchObject({ class: 'retry' });
    expect(classifyLinkAnswer({ kind: 'transport', detail: 'down' })).toMatchObject({ class: 'retry' });
  });
});
