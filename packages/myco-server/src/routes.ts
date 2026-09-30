import { handleReleaseProvenance, handleRequestReleaseCheck, handleSaveReleaseProvenance } from './api/release-provenance.js';
import { handleRepository, handleSaveRepository, handleRemoveRepository, handleRunRepository } from './api/repositories.js';
import { handleProjectMap, handleRunMap } from './api/canopy.js';
import { handleMachineSettings, handleSetMachineSetting } from './api/machine-settings.js';
import { handleSkillCandidates, handleReviewSkillCandidate } from './api/skill-candidates.js';
import type { ServerEnv } from './core/adapters.js';
import type { CredentialContext, UnboundMemberContext } from './context.js';
import type { AuthContext, DeploymentContext, GrantContext, OwnerContext, RouteContext, RunContext, SessionContext, StreamContext } from './context.js';
import { handleLink, handleMe } from './api/identity.js';
import { handleLinkGithub } from './auth/members.js';
import { clearCookie } from './auth/owner/cookie.js';
import { handleCallback, handleLogin } from './auth/owner/routes.js';
import { handleArchiveProject, handleCreateProject, handleProjects, handleUnarchiveProject, handleRenameProject } from './api/projects.js';
import { handleMemberStatus, handleStatus } from './api/status.js';
import { handleCreateMemberProject, handleMemberProjectList } from './api/member-projects.js';
import { handleDiagnostics } from './api/diagnostics.js';
import { handleProjectSearch, handleSearchAcross } from './api/search.js';
import { handleWake } from './api/wake.js';
import { handleMaintenanceStatus, handleRunMaintenance } from './api/maintenance.js';
import { handleSetTitlingBackfill, handleTitlingBackfill } from './api/titling-backfill.js';
import { handleRereadTranscripts } from './api/transcript-reread.js';
import {
  handleDeleteSecret, handleProjectCapabilities, handleSecrets, handleSetProjectCapability,
  handleMemberSettings, handleSetSecret, handleSetSetting, handleSettings,
} from './api/settings.js';
import {
  handleBackupArtifact, handleCreateBackup, handleListBackups, handlePinBackup,
  handleRestoreBackup, handleRestorePreview, handleRestoreUpload,
} from './api/backups.js';
import { handleForgetUnsettledExport, handleRecoveryExportStatus, handleStartRecoveryExport } from './api/recovery.js';
import { MAX_UPLOAD_BODY_BYTES } from './core/backup.js';
import { handleBlobRead } from './api/blobs.js';
import { handleGetSpore, handleListSpores, handleResolveSpore, handleSaveSpore } from './api/spores.js';
import { handlePromptContext, handleSessionContext } from './api/recall.js';
import {
  handleProjectDigestRevisions, handleProjectDigests, handleProjectReleaseStates,
  handleProjectSkill, handleProjectSkills, handleProjectSpore, handleProjectSpores, handleProjectInstructions,
} from './api/intelligence.js';
import {
  handleAdmitResume, handleAgents, handleClaimRun, handleGetRun, handleRecordFailure,
  handleRegisterAgent,
  handleRunReports, handleWriteReport, handleRecordRunEvents, handleSupersedeRuns, handleUpdateRun,
} from './api/runs.js';
import { handleEmbeddingStep } from './api/embedding-task.js';
import {
  handleCredentialActivity, handleCredentials, handleInvitations, handleIssueMemberLink, handleMembers, handleMintInvitation,
  handleRevokeCredential, handleRevokeInvitation, handleRevokeMember,
} from './api/access.js';
import { handleGrants, handleMintGrant, handleRevokeGrant, handleRotateGrant } from './api/grants.js';
import { CHILD_SEGMENTS, handleEndSession, handleProjectActivity, handleProjectSessions, handleSession, handleSessionChildren, handleSessionTurn, handleSessionTurnToolCalls, handleSessionTurns, handleSetPlanStatus, handleTitleSession, handleTombstoneSession, handleTranscript } from './api/sessions.js';
import { handleProjectRun, handleProjectRuns } from './api/agent-runs.js';
import { handleProjectPlans } from './api/plans.js';
import { handleKpis } from './api/kpis.js';
import { handlePlansAcross, handleSessionsAcross, handleSporesAcross } from './api/lists-all.js';
import { handleWork } from './api/work.js';
import { handleAttention } from './api/attention.js';
import { MAX_BLOB_BYTES, MEMBER_ID_SEGMENT } from './constants.js';
import { handleJoin } from './auth/join.js';
import { handleRefresh } from './auth/refresh.js';
import { handleBlob } from './ingest/blobs.js';
import { handleHarnessDispatch } from './api/harness.js';
import { handleEvents } from './ingest/events.js';
import { handleImportPlan } from './api/import.js';
import { handleGrantMcp, handleMcp, handleRunMcp, handleUnboundMcp } from './mcp/http.js';
import { handleWorkerClaim, handleWorkerEnd, handleWorkerLease, handleWorkerRepository } from './api/worker.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers on json routes receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: ServerEnv, ctx: RouteContext) => Promise<Response>;
/** Protocol handlers without a default Project; tool dispatch must resolve one before any project operation. */
export type UnboundMemberHandler = (env: ServerEnv, ctx: UnboundMemberContext) => Promise<Response>;

export type CredentialHandler = (env: ServerEnv, ctx: CredentialContext) => Promise<Response>;
/** Grant handlers answer a json route reached over an External Agent grant: the grant's Project and the consumed body, nothing of a member. A route declares one to admit grants at all. */
export type GrantHandler = (env: ServerEnv, ctx: GrantContext) => Promise<Response>;
/** Run handlers answer a json route reached over a run's credential: the run, its Project and the consumed body. A route declares one to serve the run principal at all; a run credential is refused on every member route that declares neither this nor `legacyRunRoute`. */
export type RunHandler = (env: ServerEnv, ctx: RunContext) => Promise<Response>;
/** Deployment handlers answer a route scoped to the whole Deployment rather than to one Project: a worker's claim, lease and end. A route declares one to be reached at all, and the pipeline admits only an admin member to it. */
export type DeploymentHandler = (env: ServerEnv, ctx: DeploymentContext) => Promise<Response>;
/** Member handlers on stream routes receive the unread request; the handler alone consumes the body. */
export type StreamHandler = (env: ServerEnv, request: Request, ctx: StreamContext) => Promise<Response>;
/** Auth handlers require no credential but do need the owner configuration and outbound fetch. They receive a narrowed context and never an `ServerEnv`, so a credential-free route still cannot reach storage or bindings by type. */
export type AuthHandler = (request: Request, ctx: AuthContext) => Promise<Response>;
/** Owner handlers run only after a valid session of a linked member the route's authority admits; they receive the bindings and the resolved session. */
export type OwnerHandler = (env: ServerEnv, ctx: OwnerContext) => Promise<Response>;
/** Session handlers run after a valid session whether or not its account is a member; exactly the routes that serve a signed-in non-member carry them. */
export type SessionHandler = (env: ServerEnv, ctx: SessionContext) => Promise<Response>;
/** Enroll handlers present an enrollment authority rather than a credential, so they reach storage without an authenticated member. They receive the unread request and consume its body themselves, within the bound the pipeline enforces. */
export type EnrollHandler = (env: ServerEnv, request: Request, now: number) => Promise<Response>;

/** The key a member route answers under: `{<shape>: true|false, …}` on every outcome after authentication, refusals and 503s included. */
export type Shape = 'persisted' | 'stored' | 'refreshed' | 'answered';

/** `capture: false` marks a member route that is not a member's capture: it is answered on an archived Project, where a capture route is refused. Absent, the route is capture. No route, capture or not, is refused for the bytes a credential has stored (#1416). `scope: 'credential'` marks a route answered on the presented credential alone: no Project is read from the request or resolved, whatever header it carries. Only such a route may declare `admitsLapsed: true`, the one place a credential past its own expiry still authenticates — the refresh, which decides against the lineage ceiling instead; every other route refuses an expired credential. `mintsAuthority: true` marks a member route whose answer is an authority that can outlive the presented credential — a successor token, a key that links a GitHub account and so opens the dashboard's session routes, where invitations, runtimes and grants are minted, a claimed run's credential and the provider key its harness reads, or a leased run's repository credential; a credential its issuer minted not to rotate is refused on every such route. */
export type Route =
  | { method: string; path: string; auth: 'public'; bodyMode: 'none'; handler: PublicHandler }
  | ({ method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: Exclude<Shape, 'stored'>; capture?: boolean; mintsAuthority?: true; handler: MemberHandler; grant?: GrantHandler; run?: RunHandler; legacyRunRoute?: true }
    & ({ unbound?: never } | { shape: 'answered'; capture: false; unbound: UnboundMemberHandler }))
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: 'refreshed' | 'persisted'; capture: false; scope: 'credential'; admitsLapsed?: true; mintsAuthority?: true; credential: CredentialHandler; handler?: never; grant?: never; run?: never; legacyRunRoute?: never }
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: 'persisted'; capture: false; scope: 'deployment'; mintsAuthority?: true; deployment: DeploymentHandler; handler?: never; grant?: never; run?: never; legacyRunRoute?: never }
  | { method: string; path: string; pattern: RegExp; auth: 'member'; bodyMode: 'stream'; shape: 'stored'; capture?: boolean; maxBodyBytes: number; handler: StreamHandler; legacyRunRoute?: true }
  | { method: string; path: string; auth: 'auth'; handler: AuthHandler }
  | { method: string; path: string; auth: 'enroll'; handler: EnrollHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'session'; authority: 'admin' | 'member'; maxBodyBytes?: number; handler: OwnerHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'session'; authority: 'account'; handler: SessionHandler };

/**
 * Who a dashboard session route admits, declared on the route and enforced by the pipeline alone:
 * - `admin`: a linked member whose role is admin. Every route that writes Deployment-wide state, or reads
 *   secrets, backups, maintenance or membership, is one.
 * - `member`: any linked member. A route that answers a member's own resources scopes itself to them
 *   inside its handler, as a credential revocation does.
 * - `account`: a signed-in GitHub account whether or not a member is linked to it: the two routes that
 *   link one, and the sign-out, so an account no member is linked to any longer can still clear its cookie.
 * The pipeline admits a route declaring anything but `member` or `account` as `admin`.
 */
export const SESSION_AUTHORITIES = ['admin', 'member', 'account'] as const;
export type SessionAuthority = (typeof SESSION_AUTHORITIES)[number];

async function health(): Promise<Response> {
  return Response.json({ ok: true });
}

export const ROUTES: readonly Route[] = [
  { method: 'GET', path: '/api/projects/{projectId}/canopy-map', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/canopy-map$/, auth: 'session', authority: 'member', handler: handleProjectMap },
  { method: 'GET', path: '/api/projects/{projectId}/search', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/search$/, auth: 'session', authority: 'member', handler: handleProjectSearch },
  { method: 'GET', path: '/health', auth: 'public', bodyMode: 'none', handler: health },
  { method: 'POST', path: '/api/harness/dispatch', auth: 'session', authority: 'member', handler: handleHarnessDispatch },
  { method: 'POST', path: '/api/wake', auth: 'session', authority: 'admin', handler: handleWake },
  { method: 'GET', path: '/api/maintenance', auth: 'session', authority: 'admin', handler: handleMaintenanceStatus },
  { method: 'POST', path: '/api/maintenance/{check}/run', pattern: /^\/api\/maintenance\/(?<check>[a-z]{1,32})\/run$/, auth: 'session', authority: 'admin', handler: handleRunMaintenance },
  { method: 'GET', path: '/api/titling-backfill', auth: 'session', authority: 'admin', handler: handleTitlingBackfill },
  { method: 'PUT', path: '/api/titling-backfill', auth: 'session', authority: 'admin', handler: handleSetTitlingBackfill },
  { method: 'POST', path: '/api/transcripts/reread', auth: 'session', authority: 'admin', handler: handleRereadTranscripts },
  { method: 'POST', path: '/events', auth: 'member', bodyMode: 'json', shape: 'persisted', handler: handleEvents },
  { method: 'POST', path: '/blobs/{sha256}', pattern: /^\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'member', bodyMode: 'stream', shape: 'stored', maxBodyBytes: MAX_BLOB_BYTES, handler: handleBlob },
  { method: 'POST', path: '/tokens/refresh', auth: 'member', bodyMode: 'json', shape: 'refreshed', capture: false, scope: 'credential', admitsLapsed: true, mintsAuthority: true, credential: handleRefresh },
  // #1148 — bounded import and backfill
  { method: 'POST', path: '/import/plan', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleImportPlan },
  // The run's own channel. `legacyRunRoute: true` admits the harness credential as a
  // member here alone, with whatever admission each handler performs itself —
  // `heldRun` on the task surfaces, none on the run-row handlers. The model's tool
  // surface is `/mcp`; these are the worker's and the push-launch seam's, and go
  // with the seam. `capture: false`: a run is the Deployment's own scheduled
  // intelligence, not a member's capture.
  { method: 'POST', path: '/runs/claim', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleClaimRun },
  { method: 'POST', path: '/runs/get', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleGetRun },
  { method: 'POST', path: '/runs/update', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleUpdateRun },
  { method: 'POST', path: '/runs/failed', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRecordFailure },
  { method: 'POST', path: '/runs/resume-admission', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleAdmitResume },
  { method: 'POST', path: '/runs/supersede', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleSupersedeRuns },
  { method: 'POST', path: '/runs/reports', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRunReports },
  { method: 'POST', path: '/runs/report', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleWriteReport },
  { method: 'POST', path: '/runs/events', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRecordRunEvents },
  { method: 'POST', path: '/runs/embedding-step', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleEmbeddingStep },
  { method: 'POST', path: '/spores/save', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleSaveSpore },
  { method: 'POST', path: '/spores/list', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleListSpores },
  { method: 'POST', path: '/spores/get', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleGetSpore },
  { method: 'POST', path: '/spores/resolve', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleResolveSpore },
  // What a prompt is served: the plan nudge and the session's unseen spores.
  // `capture: false`: this route answers a read of the Project's own intelligence.
  { method: 'POST', path: '/context/prompt', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handlePromptContext },
  // What a starting session or a starting subagent is served: the Project's
  // instructions, and the preferred digest where a Deployment asks for it.
  { method: 'POST', path: '/context/session', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleSessionContext },
  { method: 'POST', path: '/runs/repository', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRunRepository },
  { method: 'POST', path: '/runs/canopy-map', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRunMap },
  // The tool surface: the seven MCP tools over the Deployment for a member, the
  // read-only six for an External Agent grant, answered as JSON-RPC. `answered`
  // is its refusal shape — an error envelope, at 400 or 503.
  // #1151 — worker mode. Deployment-scoped: a worker claims from one queue
  // across every Project, so it names none and the pipeline resolves none. Only
  // an administrator is admitted: a claim answers with a minted run credential
  // and the Deployment's own harness credential.
  { method: 'POST', path: '/worker/claim', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', mintsAuthority: true, deployment: handleWorkerClaim },
  { method: 'POST', path: '/worker/lease', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerLease },
  { method: 'POST', path: '/worker/end', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerEnd },
  { method: 'POST', path: '/worker/repository', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', mintsAuthority: true, deployment: handleWorkerRepository },
  { method: 'POST', path: '/mcp', auth: 'member', bodyMode: 'json', shape: 'answered', capture: false, handler: handleMcp, grant: handleGrantMcp, run: handleRunMcp, unbound: handleUnboundMcp },
  { method: 'POST', path: '/members/join', auth: 'enroll', handler: handleJoin },
  { method: 'POST', path: '/members/link-github', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, mintsAuthority: true, handler: handleLinkGithub },
  // Deployment Settings as a member's CLI reads them: Deployment-wide, so no Project is read or created; writes stay on the dashboard's admin routes.
  { method: 'POST', path: '/members/projects', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleCreateMemberProject },
  { method: 'POST', path: '/members/projects/list', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberProjectList },
  { method: 'POST', path: '/members/settings', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberSettings },
  // Deployment health as a member's `myco stats` reads it: Deployment-wide facts, the credential's own stored bytes and the transcript retention window, so no Project is read or created.
  { method: 'POST', path: '/members/status', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberStatus },
  { method: 'GET', path: '/auth/me', auth: 'session', authority: 'account', handler: handleMe },
  { method: 'POST', path: '/auth/link', auth: 'session', authority: 'account', handler: handleLink },
  { method: 'GET', path: '/api/status', auth: 'session', authority: 'member', handler: handleStatus },
  { method: 'GET', path: '/api/diagnostics', auth: 'session', authority: 'admin', handler: handleDiagnostics },
  { method: 'GET', path: '/api/projects', auth: 'session', authority: 'member', handler: handleProjects },
  { method: 'POST', path: '/api/projects', auth: 'session', authority: 'admin', handler: handleCreateProject },
  { method: 'POST', path: '/api/projects/{projectId}/archive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/archive$/, auth: 'session', authority: 'admin', handler: handleArchiveProject },
  { method: 'POST', path: '/api/projects/{projectId}/unarchive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/unarchive$/, auth: 'session', authority: 'admin', handler: handleUnarchiveProject },
  { method: 'PATCH', path: '/api/projects/{projectId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})$/, auth: 'session', authority: 'admin', handler: handleRenameProject },
  { method: 'GET', path: '/api/projects/{projectId}/activity', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'session', authority: 'member', handler: handleProjectActivity },
  { method: 'GET', path: '/api/projects/{projectId}/sessions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions$/, auth: 'session', authority: 'member', handler: handleProjectSessions },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})$/, auth: 'session', authority: 'member', handler: handleSession },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/{child}', pattern: new RegExp(String.raw`^/api/projects/(?<projectId>[A-Za-z0-9._-]{1,64})/sessions/(?<sessionId>[^/]{1,384})/(?<child>${CHILD_SEGMENTS.join('|')})$`), auth: 'session', authority: 'member', handler: handleSessionChildren },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/transcript', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/transcript$/, auth: 'session', authority: 'member', handler: handleTranscript },
  { method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/plans/{planKey}/status', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/plans\/(?<planKey>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/status$/, auth: 'session', authority: 'admin', handler: handleSetPlanStatus },
  { method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/title', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/title$/, auth: 'session', authority: 'admin', handler: handleTitleSession },
  // #1147 — transcript-first ingest
  { method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/tombstone', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/tombstone$/, auth: 'session', authority: 'admin', handler: handleTombstoneSession },
  { method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/end', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/end$/, auth: 'session', authority: 'admin', handler: handleEndSession },
  // A session as turns: the list, one turn's body, and one turn's tool calls. A prompt id is member-minted under the envelope's id grammar.
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns$/, auth: 'session', authority: 'member', handler: handleSessionTurns },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns/{promptId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns\/(?<promptId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, auth: 'session', authority: 'member', handler: handleSessionTurn },
  { method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns/{promptId}/tool-calls', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns\/(?<promptId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tool-calls$/, auth: 'session', authority: 'member', handler: handleSessionTurnToolCalls },
  { method: 'GET', path: '/api/projects/{projectId}/blobs/{key}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'session', authority: 'member', handler: handleBlobRead },
  { method: 'GET', path: '/api/members', auth: 'session', authority: 'member', handler: handleMembers },
  { method: 'POST', path: '/api/members/{memberId}/revoke', pattern: new RegExp(`^\\/api\\/members\\/(?<memberId>${MEMBER_ID_SEGMENT})\\/revoke$`), auth: 'session', authority: 'admin', handler: handleRevokeMember },
  { method: 'POST', path: '/api/members/{memberId}/link-github', pattern: new RegExp(`^\\/api\\/members\\/(?<memberId>${MEMBER_ID_SEGMENT})\\/link-github$`), auth: 'session', authority: 'admin', handler: handleIssueMemberLink },
  { method: 'GET', path: '/api/enrollment', auth: 'session', authority: 'admin', handler: handleInvitations },
  { method: 'POST', path: '/api/enrollment', auth: 'session', authority: 'admin', handler: handleMintInvitation },
  { method: 'POST', path: '/api/enrollment/{id}/revoke', pattern: /^\/api\/enrollment\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'admin', handler: handleRevokeInvitation },
  { method: 'GET', path: '/api/credentials', auth: 'session', authority: 'member', handler: handleCredentials },
  { method: 'POST', path: '/api/credentials/{id}/revoke', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'member', handler: handleRevokeCredential },
  { method: 'GET', path: '/api/credentials/{id}/activity', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'session', authority: 'member', handler: handleCredentialActivity },
  { method: 'GET', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'session', authority: 'admin', handler: handleGrants },
  { method: 'POST', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'session', authority: 'admin', handler: handleMintGrant },
  { method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/rotate', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/rotate$/, auth: 'session', authority: 'admin', handler: handleRotateGrant },
  { method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/revoke', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'admin', handler: handleRevokeGrant },
  { method: 'GET', path: '/api/agents', auth: 'session', authority: 'member', handler: handleAgents },
  { method: 'PUT', path: '/api/agents/{agentId}', pattern: /^\/api\/agents\/(?<agentId>[A-Za-z0-9._-]{1,64})$/, auth: 'session', authority: 'admin', handler: handleRegisterAgent },
  { method: 'GET', path: '/api/projects/{projectId}/runs', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs$/, auth: 'session', authority: 'member', handler: handleProjectRuns },
  { method: 'GET', path: '/api/projects/{projectId}/runs/{runId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})$/, auth: 'session', authority: 'member', handler: handleProjectRun },
  { method: 'GET', path: '/api/projects/{projectId}/cortex/instructions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/cortex\/instructions$/, auth: 'session', authority: 'member', handler: handleProjectInstructions },
  { method: 'GET', path: '/api/projects/{projectId}/plans', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/plans$/, auth: 'session', authority: 'member', handler: handleProjectPlans },
  { method: 'GET', path: '/api/projects/{projectId}/spores', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores$/, auth: 'session', authority: 'member', handler: handleProjectSpores },
  { method: 'GET', path: '/api/projects/{projectId}/spores/{sporeId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores\/(?<sporeId>[^/]{1,192})$/, auth: 'session', authority: 'member', handler: handleProjectSpore },
  { method: 'GET', path: '/api/projects/{projectId}/skills', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills$/, auth: 'session', authority: 'member', handler: handleProjectSkills },
  { method: 'GET', path: '/api/projects/{projectId}/skill-candidates', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skill-candidates$/, auth: 'session', authority: 'member', handler: handleSkillCandidates },
  { method: 'PATCH', path: '/api/projects/{projectId}/skill-candidates/{candidateId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skill-candidates\/(?<candidateId>[^/]{1,192})$/, auth: 'session', authority: 'admin', handler: handleReviewSkillCandidate },
  { method: 'GET', path: '/api/projects/{projectId}/skills/{skillId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills\/(?<skillId>[^/]{1,192})$/, auth: 'session', authority: 'member', handler: handleProjectSkill },
  { method: 'GET', path: '/api/projects/{projectId}/digests', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests$/, auth: 'session', authority: 'member', handler: handleProjectDigests },
  { method: 'GET', path: '/api/projects/{projectId}/digests/{tier}/revisions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests\/(?<tier>\d{1,6})\/revisions$/, auth: 'session', authority: 'member', handler: handleProjectDigestRevisions },
  { method: 'GET', path: '/api/projects/{projectId}/release-states', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-states$/, auth: 'session', authority: 'member', handler: handleProjectReleaseStates },
  { method: 'POST', path: '/api/recovery/exports', auth: 'session', authority: 'admin', handler: handleStartRecoveryExport },
  { method: 'GET', path: '/api/recovery/exports', auth: 'session', authority: 'admin', handler: handleRecoveryExportStatus },
  { method: 'POST', path: '/api/recovery/exports/forget-unsettled', auth: 'session', authority: 'admin', handler: handleForgetUnsettledExport },
  { method: 'POST', path: '/api/backups', auth: 'session', authority: 'admin', handler: handleCreateBackup },
  { method: 'GET', path: '/api/backups', auth: 'session', authority: 'admin', handler: handleListBackups },
  { method: 'POST', path: '/api/backups/{backupId}/restore-preview', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore-preview$/, auth: 'session', authority: 'admin', handler: handleRestorePreview },
  { method: 'POST', path: '/api/backups/{backupId}/restore', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore$/, auth: 'session', authority: 'admin', handler: handleRestoreBackup },
  { method: 'POST', path: '/api/backups/{backupId}/pin', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/pin$/, auth: 'session', authority: 'admin', handler: handlePinBackup },
  { method: 'GET', path: '/api/backups/{backupId}/artifact', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/artifact$/, auth: 'session', authority: 'admin', handler: handleBackupArtifact },
  { method: 'POST', path: '/api/backups/restore-upload', auth: 'session', authority: 'admin', maxBodyBytes: MAX_UPLOAD_BODY_BYTES, handler: handleRestoreUpload },
  { method: 'GET', path: '/api/kpis', auth: 'session', authority: 'member', handler: handleKpis },
  // Today (#1518): the three lists across Projects, Myco's work over a window, and what needs an administrator.
  { method: 'GET', path: '/api/sessions', auth: 'session', authority: 'member', handler: handleSessionsAcross },
  { method: 'GET', path: '/api/spores', auth: 'session', authority: 'member', handler: handleSporesAcross },
  { method: 'GET', path: '/api/plans', auth: 'session', authority: 'member', handler: handlePlansAcross },
  { method: 'GET', path: '/api/search', auth: 'session', authority: 'member', handler: handleSearchAcross },
  { method: 'GET', path: '/api/work', auth: 'session', authority: 'member', handler: handleWork },
  { method: 'GET', path: '/api/attention', auth: 'session', authority: 'admin', handler: handleAttention },
  { method: 'GET', path: '/api/settings', auth: 'session', authority: 'member', handler: handleSettings },
  { method: 'PUT', path: '/api/settings/{leaf}', pattern: /^\/api\/settings\/(?<leaf>[A-Za-z0-9._]{1,96})$/, auth: 'session', authority: 'admin', handler: handleSetSetting },
  { method: 'GET', path: '/api/secrets', auth: 'session', authority: 'admin', handler: handleSecrets },
  { method: 'PUT', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'session', authority: 'admin', handler: handleSetSecret },
  { method: 'DELETE', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'session', authority: 'admin', handler: handleDeleteSecret },
  { method: 'GET', path: '/api/projects/{projectId}/capabilities', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities$/, auth: 'session', authority: 'member', handler: handleProjectCapabilities },
  { method: 'GET', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleRepository },
  { method: 'PUT', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleSaveRepository },
  { method: 'DELETE', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleRemoveRepository },
  { method: 'GET', path: '/api/projects/{projectId}/release-provenance', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance$/, auth: 'session', authority: 'admin', handler: handleReleaseProvenance },
  { method: 'PUT', path: '/api/projects/{projectId}/release-provenance', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance$/, auth: 'session', authority: 'admin', handler: handleSaveReleaseProvenance },
  { method: 'POST', path: '/api/projects/{projectId}/release-provenance/check', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance\/check$/, auth: 'session', authority: 'admin', handler: handleRequestReleaseCheck },
  { method: 'PUT', path: '/api/projects/{projectId}/capabilities/{capability}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities\/(?<capability>[a-z_]{1,32})$/, auth: 'session', authority: 'admin', handler: handleSetProjectCapability },
  // A machine's own settings (#1393): any member may ask, and the handlers answer only the member who claims the machine.
  { method: 'GET', path: '/api/machines/{machineId}/settings', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/settings$/, auth: 'session', authority: 'member', handler: handleMachineSettings },
  { method: 'PUT', path: '/api/machines/{machineId}/settings/{leaf}', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/settings\/(?<leaf>[A-Za-z0-9._]{1,96})$/, auth: 'session', authority: 'member', handler: handleSetMachineSetting },
  { method: 'GET', path: '/auth/login', auth: 'auth', handler: handleLogin },
  { method: 'GET', path: '/auth/callback', auth: 'auth', handler: handleCallback },
  { method: 'POST', path: '/auth/logout', auth: 'session', authority: 'account', handler: async () => new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } }) },
];

/** A 1.4.x wire route the server does not serve; each names the event kinds (or the blob route) that carry the same capture in 2.0, or says what it carried is gone. A retired path is unmatched and answers 401 like any other absent path. */
export interface RetiredRoute {
  method: string;
  path: string;
  replacedBy: readonly string[];
  /** What the route carried is dropped rather than replaced, and by which child. */
  dropped?: string;
}

export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { method: 'POST', path: '/sessions/register', replacedBy: ['session.start'] },
  { method: 'POST', path: '/sessions/unregister', replacedBy: ['session.end'] },
  { method: 'POST', path: '/events/stop', replacedBy: ['response'] },
  { method: 'POST', path: '/events/sync-transcript-prompts', replacedBy: ['prompt'] },
  { method: 'POST', path: '/routed-capture/transcript', replacedBy: ['POST /blobs/{sha256}', 'transcript.segment'] },
  { method: 'POST', path: '/routed-capture/plan', replacedBy: ['plan'] },
  { method: 'POST', path: '/context/subagent', replacedBy: ['subagent.start'] },
  { method: 'POST', path: '/runs/cortex-instructions', replacedBy: ['PUT /api/settings/{leaf}'] },
  { method: 'POST', path: '/runs/instruction', replacedBy: ['POST /worker/claim'] },
  { method: 'POST', path: '/runs/digest', replacedBy: ['GET /api/projects/{projectId}/digests'] },
  { method: 'POST', path: '/runs/digest-write', replacedBy: [], dropped: 'the generated digest goes (plan §3 D2, #1152); stored digests stay readable until #1170 drops the table' },
];

/**
 * Every path prefix the server answers itself, live and retired. An exact path
 * stays exact; a path with further segments becomes `/<first>/*`, which owns the
 * paths under `/<first>/` and never `/<first>` itself. A static shell served
 * beside the server hands these paths to it and answers the rest, so a
 * dashboard page may sit at `/sessions` while the server keeps `/sessions/…`.
 */
export function ownedPathPatterns(): string[] {
  const out = new Set<string>();
  for (const { path } of [...ROUTES, ...RETIRED_ROUTES]) {
    const segments = path.split('/').filter((s) => s.length > 0);
    out.add(segments.length === 1 ? `/${segments[0]}` : `/${segments[0]}/*`);
  }
  return [...out].sort();
}

/**
 * True when a pattern from `ownedPathPatterns()` covers this path, read as the
 * edge reads `run_worker_first`: `*` matches any run of characters and the
 * pattern spans the whole path, so `/x/*` covers `/x/` and below but not `/x`.
 */
export function isOwnedPath(pathname: string, patterns: readonly string[] = ownedPathPatterns()): boolean {
  return patterns.some((p) => (p.endsWith('/*') ? pathname.startsWith(p.slice(0, -1)) : pathname === p));
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
