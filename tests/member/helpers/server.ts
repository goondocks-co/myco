/**
 * The in-process worker as the member tests' server: a migrated bun:sqlite
 * D1, one member token per machine, and a `fetch` with the global signature
 * that the member transport takes by injection. Nothing here opens a socket.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import worker from '@myco-server-worker/index.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { PROJECT_HEADER, PROTOCOL_HEADER, SERVER_PROTOCOL } from '@myco-server-worker/constants.js';
import { sqliteEnv, count } from '../../myco-server/helpers/fixtures.js';
import type { BlobSource, BlobStager, MemberEnvelope } from '@myco/member/envelope.js';

export const TEST_PROJECT_ID = 'proj_1';
export const TEST_MACHINE_ID = 'machine_1';

export interface MemberRig {
  env: ReturnType<typeof sqliteEnv>;
  token: string;
  tokenId: string;
  expiresAt: number;
  /** The global-fetch-shaped entry into the worker. */
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Authenticated member headers at the current protocol. */
  headers: (extra?: Record<string, string>) => Record<string, string>;
  /** POST one envelope to /events as the rig's member; returns the parsed answer. */
  postEvent: (envelope: MemberEnvelope, over?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  /** Upload a staged blob source; returns the parsed answer. */
  uploadBlob: (source: BlobSource) => Promise<Record<string, unknown>>;
  rows: (table: string) => number;
  /** A second member token in the same project under another machine. */
  otherMachine: () => Promise<{ token: string; tokenId: string }>;
}

/** A fresh worker environment with one member of `machine_1` in `proj_1`. */
export async function memberRig(opts: { now?: number; projectId?: string; machineId?: string } = {}): Promise<MemberRig> {
  const env = sqliteEnv();
  const now = opts.now ?? Date.now();
  const projectId = opts.projectId ?? TEST_PROJECT_ID;
  const machineId = opts.machineId ?? TEST_MACHINE_ID;
  const issued = await issueMemberToken(env.db, { memberId: `mem_${machineId}`, machineId }, now);
  // The edge supplies the source identity header; the member transport never sets it.
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.headers.has('cf-connecting-ip')) return worker.fetch(req, env.env);
    const headers = new Headers(req.headers);
    headers.set('cf-connecting-ip', '1.2.3.4');
    return worker.fetch(new Request(req, { headers }), env.env);
  };
  const headers = (extra: Record<string, string> = {}) => ({
    authorization: `Bearer ${issued.token}`,
    'cf-connecting-ip': '1.2.3.4',
    [PROTOCOL_HEADER]: String(SERVER_PROTOCOL),
    // A credential is Deployment-wide, so the rig names the Project the way the
    // member transport does: on every request.
    [PROJECT_HEADER]: projectId,
    ...extra,
  });
  return {
    env,
    token: issued.token,
    tokenId: issued.tokenId,
    expiresAt: issued.expiresAt,
    fetch,
    headers,
    postEvent: async (envelope, over = {}) => {
      const res = await fetch('https://s/events', { method: 'POST', headers: headers(), body: JSON.stringify({ ...envelope, ...over }) });
      return res.json() as Promise<Record<string, unknown>>;
    },
    uploadBlob: async (source) => {
      const bytes = fs.readFileSync(source.path);
      const res = await fetch(`https://s/blobs/${source.sha256}`, {
        method: 'POST',
        headers: headers({ 'content-type': source.mediaType, 'content-length': String(bytes.byteLength) }),
        body: bytes,
      });
      return res.json() as Promise<Record<string, unknown>>;
    },
    rows: (table) => count(env.sqlite, table),
    otherMachine: () => issueMemberToken(env.db, { memberId: 'mem_machine_2', machineId: 'machine_2' }, now),
  };
}

/** A blob stager over a temp directory: bytes land in `<dir>/<sha256>`. */
export function tempStager(dir: string = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-blobs-'))): { stage: BlobStager; dir: string } {
  const stage: BlobStager = (bytes, mediaType) => {
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const file = path.join(dir, sha256);
    fs.writeFileSync(file, bytes);
    return { path: file, sha256, mediaType, size: bytes.byteLength };
  };
  return { stage, dir };
}

/** A hermetic MYCO_HOME for one test file; the machine id is pre-written so nothing shells out. */
export function tempMycoHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-member-home-'));
  fs.writeFileSync(path.join(home, 'machine_id'), TEST_MACHINE_ID, 'utf-8');
  return home;
}
