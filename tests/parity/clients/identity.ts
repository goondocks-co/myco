import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { toBase64Url } from '@myco-server-worker/base64.js';
import { PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { ageRows, MEMBER_ID, SESSION_SECRET, type ParityTarget } from '../harness.ts';
import { owner, type Answer } from './requests.ts';

/** What enrolling people and machines takes of a target: its routes, its owner and its Deployment identity. */
export type IdentityTarget = Pick<ParityTarget, 'url' | 'projectId' | 'deploymentId' | 'ownerHeaders' | 'memberHeaders'>;

/** A member who joined through an invitation and, when given an account, linked it: its runtime credential and its browser. */
export interface Person { id: string; token: string; tokenId: string; machineId: string; sub: string | null; session: Record<string, string> }

/** A browser signed in as the GitHub account `sub`; the source header is load-bearing only on Cloudflare. */
export async function accountSession(target: Pick<ParityTarget, 'deploymentId'>, sub: string, login = 'parity'): Promise<Record<string, string>> {
  const now = Date.now();
  return { cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login, iat: now, exp: now + 3_600_000 })}`, 'cf-connecting-ip': '1.2.3.4' };
}

/** A same-origin browser request as `session`: a GET without a body, a POST with one. */
export async function browser(target: Pick<ParityTarget, 'url'>, path: string, session: Record<string, string>, body?: unknown): Promise<Answer> {
  const response = await fetch(`${target.url}${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...session, origin: target.url, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
}

/** A machine or runner client's POST: its bearer when it holds one, the protocol header and a source address. */
export async function client(target: Pick<ParityTarget, 'url'>, path: string, body: unknown, bearer?: string): Promise<Answer> {
  return browser(target, path, { 'cf-connecting-ip': '1.2.3.4', ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}`, [PROTOCOL_HEADER]: String(SERVER_PROTOCOL) }) }, body);
}

/** The Deployment's owner, selected as the dashboard selects it when none is recorded: the parity member. Answers the ownership revision. */
export async function selectOwner(target: IdentityTarget): Promise<string> {
  const preview = await owner(target, '/api/ownership');
  expect(preview.status).toBe(200);
  if (preview.body.ownerMemberId !== null) return String(preview.body.revision);
  const selected = await owner(target, '/api/ownership', { method: 'POST', body: JSON.stringify({ ownerMemberId: MEMBER_ID, revision: preview.body.revision }) });
  expect({ status: selected.status, owner: selected.body.ownerMemberId }).toEqual({ status: 200, owner: MEMBER_ID });
  return String(selected.body.revision);
}

/** A member the owner invited, joined from a fresh machine; an admin invitation needs a selected owner. */
export async function joinMember(target: IdentityTarget, options: { role?: 'admin' | 'member'; machineId?: string; runtimeLabel?: string; runtimeKind?: string } = {}): Promise<Omit<Person, 'sub' | 'session'>> {
  const invite = await owner(target, '/api/enrollment', { method: 'POST', body: JSON.stringify({ role: options.role ?? 'member' }) });
  expect(invite.status).toBe(201);
  const machineId = options.machineId ?? `machine_${crypto.randomUUID()}`;
  const { role: _role, machineId: _machine, ...runtime } = options;
  const joined = await client(target, '/members/join', { key: invite.body.key, machineId, ...runtime });
  expect({ status: joined.status, joined: joined.body.joined, code: joined.body.code }).toEqual({ status: 200, joined: true, code: undefined });
  return { id: String(joined.body.memberId), token: String(joined.body.token), tokenId: String(joined.body.tokenId), machineId };
}

/** Links the GitHub account `sub` to a member as an admin does: the admin issues a key, the account confirms it signed in. */
export async function linkAccount(target: IdentityTarget, memberId: string, sub: string, issuer = target.ownerHeaders(), login = 'parity'): Promise<Record<string, string>> {
  const issued = await browser(target, `/api/members/${memberId}/link-github`, issuer, {});
  expect(issued.status).toBe(201);
  const session = await accountSession(target, sub, login);
  expect((await browser(target, '/auth/link', session, { key: issued.body.key, confirm: true })).status).toBe(200);
  return session;
}

/** A person: invited, joined from a machine of their own, and signed in with the account `sub`. */
export async function person(target: IdentityTarget, sub: string, options: Parameters<typeof joinMember>[1] & { login?: string } = {}): Promise<Person> {
  const { login, ...join } = options;
  const joined = await joinMember(target, join);
  return { ...joined, sub, session: await linkAccount(target, joined.id, sub, target.ownerHeaders(), login) };
}

/** A machine signed in through the device flow and approved in the browser `approver`; the approver's member holds it. */
export async function deviceMachine(target: IdentityTarget, approver: Record<string, string>, machineId = `machine_${crypto.randomUUID()}`, machineName = 'Parity laptop'): Promise<{ memberId: string; token: string; tokenId: string; machineId: string }> {
  const started = await client(target, '/auth/device/start', { machineId, machineName, os: 'linux' });
  expect(started.status).toBe(200);
  expect((await browser(target, '/api/device/approve', approver, { user_code: started.body.user_code })).status).toBe(200);
  const polled = await client(target, '/auth/device/poll', { device_code: started.body.device_code });
  expect(polled.body).toMatchObject({ joined: true });
  return { memberId: String(polled.body.memberId), token: String(polled.body.token), tokenId: String(polled.body.tokenId), machineId };
}

/** A fresh runner bearer, the candidate a runner offers at registration. */
export const runnerBearer = (): string => `mycorun_${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

/** A runner registered through the device flow and approved by `approver`: its id and bearer. */
export async function registerRunner(target: IdentityTarget, approver: Record<string, string>, name: string, machineId = name): Promise<{ runnerId: string; token: string }> {
  const token = runnerBearer();
  const started = await client(target, '/auth/runner/start', { name, machineId, machineName: name, os: 'linux', candidate: token });
  expect(started.status).toBe(200);
  const approved = await browser(target, '/api/device/approve-runner', approver, { user_code: started.body.user_code });
  expect(approved.status).toBe(200);
  expect((await client(target, '/auth/runner/poll', { device_code: started.body.device_code })).body).toMatchObject({ registered: true });
  return { runnerId: String(approved.body.runnerId), token };
}

/** Every row of a paged owner read, following its cursor to the end. */
async function everyRow<T>(target: IdentityTarget, path: string, key: string, session: Record<string, string>): Promise<T[]> {
  const rows: T[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 200; page += 1) {
    const answer = await browser(target, `${path}?limit=100${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`, session);
    expect(answer.status).toBe(200);
    rows.push(...answer.body[key]);
    if ((cursor = answer.body.cursor ?? null) === null) return rows;
  }
  throw new Error(`${path} did not end`);
}

export interface MemberView { id: string; label: string | null; role: 'admin' | 'member'; effectiveRole: string; roleRevision: string; linked: boolean; revokedAt: number | null; revokedBy: string | null; awaitingAdmission: boolean }
export interface CredentialView { id: string; memberId: string; machineId: string | null; runtimeLabel: string | null; expiresAt: number; revokedAt: number | null; revokedBy: string | null; predecessorId: string | null; lineageRoot: string; lineageStartedAt: number; firstUsedAt: number | null; live: boolean }

/** The Deployment's people as the People page reads them. */
export const members = (target: IdentityTarget, session = target.ownerHeaders()): Promise<MemberView[]> => everyRow(target, '/api/members', 'members', session);
/** One member as the People page reads it. */
export async function memberView(target: IdentityTarget, id: string): Promise<MemberView | undefined> {
  return (await members(target)).find((row) => row.id === id);
}
/** The Deployment's credentials as the People page reads them; a member reads only their own. */
export const credentials = (target: IdentityTarget, session = target.ownerHeaders()): Promise<CredentialView[]> => everyRow(target, '/api/credentials', 'rows', session);

/** A role the owner assigns at the revision the People page read. */
export async function assignRole(target: IdentityTarget, memberId: string, role: 'admin' | 'member', session = target.ownerHeaders()): Promise<Answer> {
  const current = await memberView(target, memberId);
  return browser(target, `/api/members/${memberId}/role`, session, { role, expected_revision: current?.roleRevision ?? '0' });
}

/** Stops a member as an admin does on the People page. */
export async function stopMember(target: IdentityTarget, memberId: string, session = target.ownerHeaders()): Promise<void> {
  expect((await browser(target, `/api/members/${memberId}/revoke`, session, {})).status).toBe(200);
}

/** Lets a credential lapse, as a machine left offline past its expiry does: its expiry moves to just before now. */
export async function lapse(target: ParityTarget, tokenId: string, pastMs = 1_000): Promise<void> {
  const row = (await credentials(target)).find((credential) => credential.id === tokenId);
  if (row === undefined) throw new Error(`credential ${tokenId} is not listed`);
  await ageRows(target, { table: 'member_credentials', column: 'expires_at', byMs: row.expiresAt - Date.now() + pastMs, match: { id: tokenId } });
}
