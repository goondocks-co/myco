import type { ServerEnv } from './core/adapters.js';
import type { AuthContext, GrantContext, OwnerContext, RouteContext, SessionContext, StreamContext } from './context.js';
import { handleLink, handleMe } from './api/identity.js';
import { handleLinkGithub } from './auth/members.js';
import { clearCookie } from './auth/owner/cookie.js';
import { handleCallback, handleLogin } from './auth/owner/routes.js';
import { handleArchiveProject, handleCreateProject, handleProjects, handleUnarchiveProject, handleRenameProject } from './api/projects.js';
import { handleStatus } from './api/status.js';
import {
  handleDeleteSecret, handleProjectCapabilities, handleSecrets, handleSetProjectCapability,
  handleSetSecret, handleSetSetting, handleSettings,
} from './api/settings.js';
import {
  handleBackupArtifact, handleCreateBackup, handleListBackups, handlePinBackup,
  handleRestoreBackup, handleRestorePreview, handleRestoreUpload,
} from './api/backups.js';
import { handleBlobRead } from './api/blobs.js';
import { handleGetSpore, handleListSpores, handleResolveSpore, handleSaveSpore } from './api/spores.js';
import {
  handleProjectDigestRevisions, handleProjectDigests, handleProjectReleaseStates,
  handleProjectSkill, handleProjectSkills, handleProjectSpore, handleProjectSpores, handleProjectInstructions,
} from './api/intelligence.js';
import {
  handleAdmitResume, handleAgents, handleClaimRun, handleGetRun, handleReadState, handleRecordFailure,
  handleRegisterAgent, handleRunAdmission,
  handleRunReports, handleWriteReport, handleRecordRunEvents, handleSupersedeRuns, handleUpdateRun, handleUpsertCortexInstructions, handleWriteState,
} from './api/runs.js';
import {
  handleCredentialActivity, handleCredentials, handleInvitations, handleMembers, handleMintInvitation,
  handleRevokeCredential, handleRevokeInvitation, handleRevokeMember,
} from './api/access.js';
import { handleGrants, handleMintGrant, handleRevokeGrant, handleRotateGrant } from './api/grants.js';
import { handleProjectActivity, handleProjectSessions, handleSession, handleSessionChildren, handleTranscript } from './api/sessions.js';
import { handleProjectRun, handleProjectRuns } from './api/agent-runs.js';
import { MAX_BLOB_BYTES, MEMBER_ID_SEGMENT } from './constants.js';
import { handleJoin } from './auth/join.js';
import { handleRefresh } from './auth/refresh.js';
import { handleBlob } from './ingest/blobs.js';
import { handleHarnessDispatch, handleHarnessProbe } from './api/harness.js';
import { handleEvents } from './ingest/events.js';
import { handleGrantMcp, handleMcp } from './mcp/http.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers on json routes receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: ServerEnv, ctx: RouteContext) => Promise<Response>;
/** Grant handlers answer a json route reached over an External Agent grant: the grant's Project and the consumed body, nothing of a member. A route declares one to admit grants at all. */
export type GrantHandler = (env: ServerEnv, ctx: GrantContext) => Promise<Response>;
/** Member handlers on stream routes receive the unread request; the handler alone consumes the body. */
export type StreamHandler = (env: ServerEnv, request: Request, ctx: StreamContext) => Promise<Response>;
/** Auth handlers require no credential but do need the owner configuration and outbound fetch. They receive a narrowed context and never an `ServerEnv`, so a credential-free route still cannot reach storage or bindings by type. */
export type AuthHandler = (request: Request, ctx: AuthContext) => Promise<Response>;
/** Owner handlers run only after a valid owner session; they receive the bindings and the resolved session. */
export type OwnerHandler = (env: ServerEnv, ctx: OwnerContext) => Promise<Response>;
/** Session handlers run after a valid session whether or not its account is a member; exactly the routes that serve a signed-in non-member carry them. */
export type SessionHandler = (env: ServerEnv, ctx: SessionContext) => Promise<Response>;
/** Enroll handlers present an enrollment authority rather than a credential, so they reach storage without an authenticated member. They receive the unread request and consume its body themselves, within the bound the pipeline enforces. */
export type EnrollHandler = (env: ServerEnv, request: Request, now: number) => Promise<Response>;

/** The key a member route answers under: `{<shape>: true|false, …}` on every outcome after authentication, refusals and 503s included. */
export type Shape = 'persisted' | 'stored' | 'refreshed' | 'answered';

/** `quotaPrecheck: false` marks a member route the pipeline does not pre-check against the byte quota and never reads a constraint failure as a quota refusal; what such a route stores through the ingest path is still charged there. Absent, the route is pre-checked. */
export type Route =
  | { method: string; path: string; auth: 'public'; bodyMode: 'none'; handler: PublicHandler }
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: Exclude<Shape, 'stored'>; quotaPrecheck?: boolean; handler: MemberHandler; grant?: GrantHandler }
  | { method: string; path: string; pattern: RegExp; auth: 'member'; bodyMode: 'stream'; shape: 'stored'; quotaPrecheck?: boolean; maxBodyBytes: number; handler: StreamHandler }
  | { method: string; path: string; auth: 'auth'; handler: AuthHandler }
  | { method: string; path: string; auth: 'enroll'; handler: EnrollHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'owner'; membership?: never; handler: OwnerHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'owner'; membership: 'optional'; handler: SessionHandler };

async function health(): Promise<Response> {
  return Response.json({ ok: true });
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/health', auth: 'public', bodyMode: 'none', handler: health },
  { method: 'POST', path: '/api/harness/probe', auth: 'owner', handler: handleHarnessProbe },
  { method: 'POST', path: '/api/harness/dispatch', auth: 'owner', handler: handleHarnessDispatch },
  { method: 'POST', path: '/events', auth: 'member', bodyMode: 'json', shape: 'persisted', handler: handleEvents },
  { method: 'POST', path: '/blobs/{sha256}', pattern: /^\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'member', bodyMode: 'stream', shape: 'stored', maxBodyBytes: MAX_BLOB_BYTES, handler: handleBlob },
  { method: 'POST', path: '/tokens/refresh', auth: 'member', bodyMode: 'json', shape: 'refreshed', quotaPrecheck: false, handler: handleRefresh },
  // The run control plane. `quotaPrecheck: false`: the byte quota bounds what a
  // member's CAPTURE may write, and charging a Deployment's own scheduled
  // intelligence against a human's capture allowance would let ordinary agent
  // work exhaust that member's ability to record their sessions.
  { method: 'POST', path: '/runs/claim', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleClaimRun },
  { method: 'POST', path: '/runs/admission', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleRunAdmission },
  { method: 'POST', path: '/runs/get', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleGetRun },
  { method: 'POST', path: '/runs/update', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleUpdateRun },
  { method: 'POST', path: '/runs/failed', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleRecordFailure },
  { method: 'POST', path: '/runs/resume-admission', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleAdmitResume },
  { method: 'POST', path: '/runs/supersede', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleSupersedeRuns },
  { method: 'POST', path: '/runs/reports', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleRunReports },
  { method: 'POST', path: '/runs/report', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleWriteReport },
  { method: 'POST', path: '/runs/events', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleRecordRunEvents },
  { method: 'POST', path: '/runs/cortex-instructions', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleUpsertCortexInstructions },
  { method: 'POST', path: '/spores/save', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleSaveSpore },
  { method: 'POST', path: '/spores/list', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleListSpores },
  { method: 'POST', path: '/spores/get', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleGetSpore },
  { method: 'POST', path: '/spores/resolve', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleResolveSpore },
  { method: 'POST', path: '/runs/state/read', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleReadState },
  { method: 'POST', path: '/runs/state/write', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleWriteState },
  // The tool surface: the seven MCP tools over the Deployment for a member, the
  // read-only six for an External Agent grant, answered as JSON-RPC. `answered`
  // is its refusal shape — an error envelope, at 400 or 503.
  { method: 'POST', path: '/mcp', auth: 'member', bodyMode: 'json', shape: 'answered', quotaPrecheck: false, handler: handleMcp, grant: handleGrantMcp },
  { method: 'POST', path: '/members/join', auth: 'enroll', handler: handleJoin },
  { method: 'POST', path: '/members/link-github', auth: 'member', bodyMode: 'json', shape: 'persisted', quotaPrecheck: false, handler: handleLinkGithub },
  { method: 'GET', path: '/auth/me', auth: 'owner', membership: 'optional', handler: handleMe },
  { method: 'POST', path: '/auth/link', auth: 'owner', membership: 'optional', handler: handleLink },
  { method: 'GET', path: '/api/status', auth: 'owner', handler: handleStatus },
  { method: 'GET', path: '/api/projects', auth: 'owner', handler: handleProjects },
  { method: 'POST', path: '/api/projects', auth: 'owner', handler: handleCreateProject },
  { method: 'POST', path: '/api/projects/{projectId}/archive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/archive$/, auth: 'owner', handler: handleArchiveProject },
  { method: 'POST', path: '/api/projects/{projectId}/unarchive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/unarchive$/, auth: 'owner', handler: handleUnarchiveProject },
  { method: 'PATCH', path: '/api/projects/{projectId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})$/, auth: 'owner', handler: handleRenameProject },
  { method: 'GET', path: '/api/projects/{projectId}/activity', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'owner', handler: handleProjectActivity },
  { method: 'GET', path: '/api/projects/{projectId}/sessions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions$/, auth: 'owner', handler: handleProjectSessions },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})$/, auth: 'owner', handler: handleSession },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/{child}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/(?<child>prompts|tool-calls|responses|plans|attachments)$/, auth: 'owner', handler: handleSessionChildren },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/transcript', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/transcript$/, auth: 'owner', handler: handleTranscript },
  { method: 'GET', path: '/api/projects/{projectId}/blobs/{key}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'owner', handler: handleBlobRead },
  { method: 'GET', path: '/api/members', auth: 'owner', handler: handleMembers },
  { method: 'POST', path: '/api/members/{memberId}/revoke', pattern: new RegExp(`^\\/api\\/members\\/(?<memberId>${MEMBER_ID_SEGMENT})\\/revoke$`), auth: 'owner', handler: handleRevokeMember },
  { method: 'GET', path: '/api/enrollment', auth: 'owner', handler: handleInvitations },
  { method: 'POST', path: '/api/enrollment', auth: 'owner', handler: handleMintInvitation },
  { method: 'POST', path: '/api/enrollment/{id}/revoke', pattern: /^\/api\/enrollment\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'owner', handler: handleRevokeInvitation },
  { method: 'GET', path: '/api/credentials', auth: 'owner', handler: handleCredentials },
  { method: 'POST', path: '/api/credentials/{id}/revoke', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'owner', handler: handleRevokeCredential },
  { method: 'GET', path: '/api/credentials/{id}/activity', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'owner', handler: handleCredentialActivity },
  { method: 'GET', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'owner', handler: handleGrants },
  { method: 'POST', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'owner', handler: handleMintGrant },
  { method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/rotate', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/rotate$/, auth: 'owner', handler: handleRotateGrant },
  { method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/revoke', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'owner', handler: handleRevokeGrant },
  { method: 'GET', path: '/api/agents', auth: 'owner', handler: handleAgents },
  { method: 'PUT', path: '/api/agents/{agentId}', pattern: /^\/api\/agents\/(?<agentId>[A-Za-z0-9._-]{1,64})$/, auth: 'owner', handler: handleRegisterAgent },
  { method: 'GET', path: '/api/projects/{projectId}/runs', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs$/, auth: 'owner', handler: handleProjectRuns },
  { method: 'GET', path: '/api/projects/{projectId}/runs/{runId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})$/, auth: 'owner', handler: handleProjectRun },
  { method: 'GET', path: '/api/projects/{projectId}/cortex/instructions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/cortex\/instructions$/, auth: 'owner', handler: handleProjectInstructions },
  { method: 'GET', path: '/api/projects/{projectId}/spores', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores$/, auth: 'owner', handler: handleProjectSpores },
  { method: 'GET', path: '/api/projects/{projectId}/spores/{sporeId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores\/(?<sporeId>[^/]{1,192})$/, auth: 'owner', handler: handleProjectSpore },
  { method: 'GET', path: '/api/projects/{projectId}/skills', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills$/, auth: 'owner', handler: handleProjectSkills },
  { method: 'GET', path: '/api/projects/{projectId}/skills/{skillId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills\/(?<skillId>[^/]{1,192})$/, auth: 'owner', handler: handleProjectSkill },
  { method: 'GET', path: '/api/projects/{projectId}/digests', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests$/, auth: 'owner', handler: handleProjectDigests },
  { method: 'GET', path: '/api/projects/{projectId}/digests/{tier}/revisions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests\/(?<tier>\d{1,6})\/revisions$/, auth: 'owner', handler: handleProjectDigestRevisions },
  { method: 'GET', path: '/api/projects/{projectId}/release-states', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-states$/, auth: 'owner', handler: handleProjectReleaseStates },
  { method: 'POST', path: '/api/backups', auth: 'owner', handler: handleCreateBackup },
  { method: 'GET', path: '/api/backups', auth: 'owner', handler: handleListBackups },
  { method: 'POST', path: '/api/backups/{backupId}/restore-preview', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore-preview$/, auth: 'owner', handler: handleRestorePreview },
  { method: 'POST', path: '/api/backups/{backupId}/restore', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore$/, auth: 'owner', handler: handleRestoreBackup },
  { method: 'POST', path: '/api/backups/{backupId}/pin', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/pin$/, auth: 'owner', handler: handlePinBackup },
  { method: 'GET', path: '/api/backups/{backupId}/artifact', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/artifact$/, auth: 'owner', handler: handleBackupArtifact },
  { method: 'POST', path: '/api/backups/restore-upload', auth: 'owner', handler: handleRestoreUpload },
  { method: 'GET', path: '/api/settings', auth: 'owner', handler: handleSettings },
  { method: 'PUT', path: '/api/settings/{leaf}', pattern: /^\/api\/settings\/(?<leaf>[A-Za-z0-9._]{1,96})$/, auth: 'owner', handler: handleSetSetting },
  { method: 'GET', path: '/api/secrets', auth: 'owner', handler: handleSecrets },
  { method: 'PUT', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'owner', handler: handleSetSecret },
  { method: 'DELETE', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'owner', handler: handleDeleteSecret },
  { method: 'GET', path: '/api/projects/{projectId}/capabilities', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities$/, auth: 'owner', handler: handleProjectCapabilities },
  { method: 'PUT', path: '/api/projects/{projectId}/capabilities/{capability}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities\/(?<capability>[a-z_]{1,32})$/, auth: 'owner', handler: handleSetProjectCapability },
  { method: 'GET', path: '/auth/login', auth: 'auth', handler: handleLogin },
  { method: 'GET', path: '/auth/callback', auth: 'auth', handler: handleCallback },
  { method: 'POST', path: '/auth/logout', auth: 'owner', handler: async () => new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } }) },
];

/** A 1.4.x wire route the server does not serve; each names the event kinds (or the blob route) that carry the same capture in 2.0. A retired path is unmatched and answers 401 like any other absent path. */
export interface RetiredRoute {
  method: string;
  path: string;
  replacedBy: readonly string[];
}

export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { method: 'POST', path: '/sessions/register', replacedBy: ['session.start'] },
  { method: 'POST', path: '/sessions/unregister', replacedBy: ['session.end'] },
  { method: 'POST', path: '/events/stop', replacedBy: ['response'] },
  { method: 'POST', path: '/events/sync-transcript-prompts', replacedBy: ['prompt'] },
  { method: 'POST', path: '/routed-capture/transcript', replacedBy: ['POST /blobs/{sha256}', 'transcript.segment'] },
  { method: 'POST', path: '/routed-capture/plan', replacedBy: ['plan'] },
  { method: 'POST', path: '/context/subagent', replacedBy: ['subagent.start'] },
];

/**
 * Every path prefix the server answers itself, live and retired. An exact path
 * stays exact; a path with further segments becomes `/<first>/*`. A static
 * shell served beside the server hands these paths to it and answers the rest.
 */
export function ownedPathPatterns(): string[] {
  const out = new Set<string>();
  for (const { path } of [...ROUTES, ...RETIRED_ROUTES]) {
    const segments = path.split('/').filter((s) => s.length > 0);
    out.add(segments.length === 1 ? `/${segments[0]}` : `/${segments[0]}/*`);
  }
  return [...out].sort();
}

/** True when a pattern from `ownedPathPatterns()` covers this path. */
export function isOwnedPath(pathname: string, patterns: readonly string[] = ownedPathPatterns()): boolean {
  return patterns.some((p) => (p.endsWith('/*') ? pathname === p.slice(0, -2) || pathname.startsWith(p.slice(0, -1)) : pathname === p));
}

/** Every route that admits an External Agent grant, as `METHOD path`. */
export function grantRoutes(): string[] {
  return ROUTES.filter((r) => r.auth === 'member' && r.bodyMode === 'json' && r.grant !== undefined).map((r) => `${r.method} ${r.path}`).sort();
}

/** The methods the routes `admitted` admits serve at this path, sorted and distinct; empty when none does. */
export function methodsServing(pathname: string, admitted: (route: Route) => boolean): string[] {
  const out = new Set<string>();
  for (const route of ROUTES) {
    if (!admitted(route)) continue;
    const pattern = 'pattern' in route ? route.pattern : undefined;
    if (pattern !== undefined ? pattern.test(pathname) : route.path === pathname) out.add(route.method);
  }
  return [...out].sort();
}

export interface RouteMatch {
  route: Route;
  params: Record<string, string>;
}

/** Exact method and path match for path routes; pattern routes capture their named segments. */
export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of ROUTES) {
    if (route.method !== method) continue;
    const pattern = 'pattern' in route ? route.pattern : undefined;
    if (pattern !== undefined) {
      const m = pattern.exec(pathname);
      if (m) return { route, params: { ...m.groups } };
    } else if (route.path === pathname) {
      return { route, params: {} };
    }
  }
  return null;
}
