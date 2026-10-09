import { handleDeviceStart, handleDevicePoll, handleDevicePreview, handleDeviceApprove, handleDeviceDeny, handleRunnerDeviceStart, handleRunnerDevicePoll, handleRunnerDeviceApprove } from './auth/device.js';
import { handleForgetLegacyWorker, handleRenameRunner, handleRecredentialRunner, handleRequestRunnerUpdate, handleControlRunner, handleListRunners, handleLegacyWorkers, handleRunnerContact, handleRunnerRotate } from './api/runners.js';
import { handleCredentialRoles, handleOwnershipTransfer, handleMemberOwnershipTransfer, handleMemberRole, handleCredentialMemberRole } from './api/ownership.js';
import { handleCancelRun } from './api/run-cancel.js';
import { memberRevocationAction, httpPolicy, invitationAction, runDispatchAction, RUN_CANCEL_POLICY } from './auth/http-authorization.js';
import type { AuthorizationDeclaration } from './auth/authorization.js';
import { handleRawClaimPreview, handleRawClaim, handleMemberRawClaimPreview, handleMemberRawClaim, handleOwnershipPreview, handleOwnership, handleMemberOwnershipPreview, handleMemberOwnership } from './api/raw-claims.js';
import type { RawAction, RawResource } from './core/raw-resources.js';
import { handleProcessedBody } from './api/processed.js';
import { handleReleaseProvenance, handleRequestReleaseCheck, handleSaveReleaseProvenance } from './api/release-provenance.js';
import { handleRepository, handleSaveRepository, handleRemoveRepository, handleRunRepository } from './api/repositories.js';
import { handleProjectMap, handleRunMap } from './api/canopy.js';
import { handleMachineSettings, handleSetMachineSetting } from './api/machine-settings.js';
import { handleMachineActivity, handleMachines, handleRenameMachine, handleStopMachine } from './api/machines.js';
import { handleConnectUncaptured, handleListUncaptured } from './api/uncaptured.js';
import { handleSkillCandidates, handleReviewSkillCandidate } from './api/skill-candidates.js';
import type { ServerEnv } from './core/adapters.js';
import type { CredentialContext, RunnerContext, UnboundMemberContext } from './context.js';
import type { AuthContext, DeploymentContext, GrantContext, OwnerContext, RouteContext, RunContext, SessionContext, StreamContext } from './context.js';
import { handleLink, handleMe } from './api/identity.js';
import { handleLinkGithub } from './auth/members.js';
import { clearCookie } from './auth/owner/cookie.js';
import { handleCallback, handleLogin } from './auth/owner/routes.js';
import { handleArchiveProject, handleCreateProject, handleProjects, handleUnarchiveProject, handleRenameProject } from './api/projects.js';
import { handleMemberStatus, handleStatus } from './api/status.js';
import { handleCreateMemberProject, handleMemberProjectList, handleReportUncaptured, handleUncapturedState, handleResolveMemberProject } from './api/member-projects.js';
import { handleProvisionedHarnessReport } from './api/harness-health.js';
import { handleDiagnostics } from './api/diagnostics.js';
import { handleProjectSearch, handleSearchAcross } from './api/search.js';
import { handleWake } from './api/wake.js';
import { handleStorageCleanup,handleSetStorageCleanup } from './api/storage-cleanup.js';
import { handleMaintenanceStatus, handleRunMaintenance } from './api/maintenance.js';
import { handleSetTitlingBackfill, handleTitlingBackfill } from './api/titling-backfill.js';
import { handleRereadTranscripts } from './api/transcript-reread.js';
import {
  handleDeleteSecret, handleProjectCapabilities, handleSecrets, handleSetProjectCapability,
  handleMemberSettings, handleRepairTaskDocument, handleResetSetting, handleSetEmbedding, handlePassedOverSources, handleEmbeddingSwitch, handleStartEmbeddingSwitch, handleEstimateEmbeddingSwitch, handleCancelEmbeddingSwitch, handleResumeEmbeddingSwitch, handleSetSecret, handleSetSetting, handleSetTaskTier, handleSettings,
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
  handleAgents, handleClaimRun, handleRegisterAgent, handleWriteReport, handleUpdateRun, retiredRunRoute,
} from './api/runs.js';
import { handleEmbeddingStep } from './api/embedding-task.js';
import {
  handleCredentialActivity, handleCredentials, handleInvitations, handleIssueMemberLink, handleMembers, handleMintInvitation,
  handleRevokeCredential, handleRevokeInvitation, handleRevokeMember,
} from './api/access.js';
import { handleGrants, handleMintGrant, handleRevokeGrant, handleRotateGrant } from './api/grants.js';
import { CHILD_SEGMENTS, handleEndSession, handleProjectActivity, handleProjectSessions, handleSession, handleSessionChildren, handleSessionTurn, handleSessionTurnToolCalls, handleSessionTurns, handleSetPlanStatus, handleTitleSession, handleTombstoneSession, handleTranscript } from './api/sessions.js';
import { handleProjectRun, handleProjectRunCalls, handleProjectRunSteps, handleProjectRuns } from './api/agent-runs.js';
import { handleProjectPlan, handleProjectPlans } from './api/plans.js';
import { handleKpis } from './api/kpis.js';
import { handlePlansAcross, handleSessionsAcross, handleSporesAcross } from './api/lists-all.js';
import { handleTaskDescriptions, handleTaskNames, handleTaskStartPreview } from './api/task-descriptions.js';
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
import { handleWorkerClaim, handleWorkerEnd, handleWorkerLease, handleWorkerModels, handleWorkerRepository, handleWorkerSteps } from './api/worker.js';

/** Public handlers receive the request only; they cannot reach storage or bindings. */
export type PublicHandler = (request: Request) => Promise<Response>;
/** Member handlers on json routes receive the bindings and the consumed request as context; the request stream is spent by the pipeline. */
export type MemberHandler = (env: ServerEnv, ctx: RouteContext) => Promise<Response>;
/** Protocol handlers without a default Project; tool dispatch must resolve one before any project operation. */
export type UnboundMemberHandler = (env: ServerEnv, ctx: UnboundMemberContext) => Promise<Response>;

export type CredentialHandler = (env: ServerEnv, ctx: CredentialContext) => Promise<Response>;
/** Grant handlers answer a json route reached over an External Agent grant: the grant's Project and the consumed body, nothing of a member. A route declares one to admit grants at all. */
export type GrantHandler = (env: ServerEnv, ctx: GrantContext) => Promise<Response>;
/** Run handlers answer a json route reached over a run's credential: the run, its Project and the consumed body. A route declares one to serve the run principal at all; the retained runtime channel declares `legacyRunRoute` and resolves its dispatch principal at the pipeline. */
export type RunHandler = (env: ServerEnv, ctx: RunContext) => Promise<Response>;
/** Deployment handlers answer a route scoped to the whole Deployment rather than to one Project: a worker's claim, lease and end. A route declares one to be reached at all, and the pipeline admits the subjects its declaration names: an administrator's legacy worker, and a runner where the declaration names one. */
export type DeploymentHandler = (env: ServerEnv, ctx: DeploymentContext) => Promise<Response>;
/** Member handlers on stream routes receive the unread request; the handler alone consumes the body. */
export type StreamHandler = (env: ServerEnv, request: Request, ctx: StreamContext) => Promise<Response>;
/** Auth handlers require no credential but do need the owner configuration and outbound fetch. They receive a narrowed context and never an `ServerEnv`, so a credential-free route still cannot reach storage or bindings by type. */
export type AuthHandler = (request: Request, ctx: AuthContext) => Promise<Response>;
/** Owner handlers run only after a valid session of a linked member the route's authority admits; they receive the bindings and the resolved session. */
export type OwnerHandler = (env: ServerEnv, ctx: OwnerContext) => Promise<Response>;
/** Session handlers run after a valid session whether or not its account is a member; exactly the routes that serve a signed-in non-member carry them. */
export type SessionHandler = (env: ServerEnv, ctx: SessionContext) => Promise<Response>;
/** Runner handlers answer a route only a runner credential reaches: its own contact and rotation. */
export type RunnerHandler = (env: ServerEnv, ctx: RunnerContext) => Promise<Response>;
/** Enroll handlers present an enrollment authority rather than a credential, so they reach storage without an authenticated member. They receive the unread request and consume its body themselves, within the bound the pipeline enforces. */
export type EnrollHandler = (env: ServerEnv, request: Request, now: number, source: string) => Promise<Response>;

/** The key a member route answers under: `{<shape>: true|false, …}` on every outcome after authentication, refusals and 503s included. */
export type Shape = 'persisted' | 'stored' | 'refreshed' | 'answered';

/** `capture: false` marks a member route that is not a member's capture: it is answered on an archived Project, where a capture route is refused. Absent, the route is capture. No route, capture or not, is refused for the bytes a credential has stored (#1416). `scope: 'credential'` marks a route answered on the presented credential alone: no Project is read from the request or resolved, whatever header it carries. Only such a route may declare `admitsLapsed: true`, the one place a credential past its own expiry still authenticates — the refresh, which decides against the lineage ceiling instead; every other route refuses an expired credential. `mintsAuthority: true` marks a member route whose answer is an authority that can outlive the presented credential — a successor token, a key that links a GitHub account and so opens the dashboard's session routes, where invitations, runtimes and grants are minted, a claimed run's credential and the provider key its harness reads, or a leased run's repository credential; a credential its issuer minted not to rotate is refused on every such route. */
export type Route = { authorization: AuthorizationDeclaration } & (
  | { method: string; path: string; auth: 'public'; bodyMode: 'none'; handler: PublicHandler }
  | ({ method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: Exclude<Shape, 'stored'>; capture?: boolean; mintsAuthority?: true; handler: MemberHandler; grant?: GrantHandler; run?: RunHandler; legacyRunRoute?: true; retired?: true }
    & ({ unbound?: never } | { shape: 'answered'; capture: false; unbound: UnboundMemberHandler }))
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: 'refreshed' | 'persisted'; capture: false; scope: 'credential'; admitsLapsed?: true; mintsAuthority?: true; credential: CredentialHandler; handler?: never; grant?: never; run?: never; legacyRunRoute?: never }
  | { method: string; path: string; auth: 'member'; bodyMode: 'json'; shape: 'persisted'; capture: false; scope: 'deployment'; mintsAuthority?: true; deployment: DeploymentHandler; handler?: never; grant?: never; run?: never; legacyRunRoute?: never }
  | { method: string; path: string; pattern: RegExp; auth: 'member'; bodyMode: 'stream'; shape: 'stored'; capture?: boolean; maxBodyBytes: number; handler: StreamHandler; legacyRunRoute?: true }
  | { method: string; path: string; auth: 'auth'; handler: AuthHandler }
  | { method: string; path: string; auth: 'enroll'; subject?: 'enrollment' | 'runner-registration'; handler: EnrollHandler }
  | { method: string; path: string; auth: 'runner'; bodyMode: 'json'; shape: 'persisted'; admitsLapsed?: true; runner: RunnerHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'session'; authority: 'admin' | 'member'; raw?: { resource: RawResource['kind']; action: RawAction }; maxBodyBytes?: number; handler: OwnerHandler }
  | { method: string; path: string; pattern?: RegExp; auth: 'session'; authority: 'account'; handler: SessionHandler });

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
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['enrollment']), method: 'POST', path: '/auth/device/start', auth: 'enroll', handler: handleDeviceStart },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['enrollment']), method: 'POST', path: '/auth/device/poll', auth: 'enroll', handler: handleDevicePoll },
  { authorization: httpPolicy('directory', 'read', 'deployment'), method: 'POST', path: '/api/device/preview', auth: 'session', authority: 'member', handler: handleDevicePreview },
  { authorization: httpPolicy('enrollment', 'enroll.self', 'self-enrollment'), method: 'POST', path: '/api/device/approve', auth: 'session', authority: 'member', handler: handleDeviceApprove },
  { authorization: httpPolicy('directory', 'read', 'deployment'), method: 'POST', path: '/api/device/deny', auth: 'session', authority: 'member', handler: handleDeviceDeny },
  { authorization: httpPolicy('runner', 'admin', 'deployment'), method: 'POST', path: '/api/device/approve-runner', auth: 'session', authority: 'admin', handler: handleRunnerDeviceApprove },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['runner-registration']), method: 'POST', path: '/auth/runner/start', auth: 'enroll', subject: 'runner-registration', handler: handleRunnerDeviceStart },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['runner-registration']), method: 'POST', path: '/auth/runner/poll', auth: 'enroll', subject: 'runner-registration', handler: handleRunnerDevicePoll },
  { authorization: httpPolicy('runner', 'read', 'runner', ['runner']), method: 'POST', path: '/runners/contact', auth: 'runner', bodyMode: 'json', shape: 'persisted', runner: handleRunnerContact },
  { authorization: httpPolicy('runner', 'edit', 'runner', ['runner']), method: 'POST', path: '/runners/rotate', auth: 'runner', bodyMode: 'json', shape: 'persisted', admitsLapsed: true, runner: handleRunnerRotate },
  { authorization: httpPolicy('legacy-worker', 'admin', 'deployment'), method: 'POST', path: '/api/workers/legacy/{credentialId}/forget',
    pattern: /^\/api\/workers\/legacy\/(?<credentialId>[A-Za-z0-9._-]{1,64})\/forget$/, auth: 'session', authority: 'admin', handler: handleForgetLegacyWorker },
  { authorization: httpPolicy('legacy-worker', 'read', 'deployment', ['member']), method: 'GET', path: '/api/workers/legacy', auth: 'session', authority: 'member', handler: handleLegacyWorkers },
  { authorization: httpPolicy('runner', 'read', 'deployment'), method: 'GET', path: '/api/runners', auth: 'session', authority: 'member', handler: handleListRunners },
  { authorization: httpPolicy('runner', 'admin', 'runner'), method: 'POST', path: '/api/runners/{runnerId}/update',
    pattern: /^\/api\/runners\/(?<runnerId>[A-Za-z0-9._-]{1,64})\/update$/, auth: 'session', authority: 'admin', handler: handleRequestRunnerUpdate },
  ...([['rename', handleRenameRunner], ['recredential', handleRecredentialRunner]] as const).map(([action, handler]): Route => ({
    authorization: httpPolicy('runner', 'admin', 'runner'), method: 'POST', path: `/api/runners/{runnerId}/${action}`,
    pattern: new RegExp(`^/api/runners/(?<runnerId>[A-Za-z0-9._-]{1,64})/${action}$`), auth: 'session', authority: 'admin', handler,
  })),
  ...(['pause', 'resume', 'remove'] as const).map((control): Route => ({
    authorization: httpPolicy('runner', 'admin', 'runner'), method: 'POST', path: `/api/runners/{runnerId}/${control}`,
    pattern: new RegExp(`^/api/runners/(?<runnerId>[A-Za-z0-9._-]{1,64})/${control}$`), auth: 'session', authority: 'admin', handler: handleControlRunner(control),
  })),
  { authorization: RUN_CANCEL_POLICY, method: 'POST', path: '/api/projects/{projectId}/runs/{runId}/cancel', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})\/cancel$/, auth: 'session', authority: 'member', handler: handleCancelRun },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/canopy-map', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/canopy-map$/, auth: 'session', authority: 'member', handler: handleProjectMap },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/search', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/search$/, auth: 'session', authority: 'member', handler: handleProjectSearch },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['public']), method: 'GET', path: '/health', auth: 'public', bodyMode: 'none', handler: health },
  { authorization: httpPolicy('run', runDispatchAction, 'project', ['member']), method: 'POST', path: '/api/harness/dispatch', auth: 'session', authority: 'member', handler: handleHarnessDispatch },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/wake', auth: 'session', authority: 'admin', handler: handleWake },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/storage-cleanup', auth: 'session', authority: 'admin', handler: handleStorageCleanup },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PATCH', path: '/api/storage-cleanup', auth: 'session', authority: 'admin', handler: handleSetStorageCleanup },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/maintenance', auth: 'session', authority: 'admin', handler: handleMaintenanceStatus },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/maintenance/{check}/run', pattern: /^\/api\/maintenance\/(?<check>[a-z]{1,32})\/run$/, auth: 'session', authority: 'admin', handler: handleRunMaintenance },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/titling-backfill', auth: 'session', authority: 'admin', handler: handleTitlingBackfill },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PUT', path: '/api/titling-backfill', auth: 'session', authority: 'admin', handler: handleSetTitlingBackfill },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/transcripts/reread', auth: 'session', authority: 'admin', handler: handleRereadTranscripts },
  { authorization: httpPolicy('processed', 'capture', 'project', ['member']), method: 'POST', path: '/events', auth: 'member', bodyMode: 'json', shape: 'persisted', handler: handleEvents },
  { authorization: httpPolicy('raw', 'append', 'project', ['member']), method: 'POST', path: '/blobs/{sha256}', pattern: /^\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'member', bodyMode: 'stream', shape: 'stored', maxBodyBytes: MAX_BLOB_BYTES, handler: handleBlob },
  { authorization: httpPolicy('credential', 'edit', 'credential', ['member']), method: 'POST', path: '/tokens/refresh', auth: 'member', bodyMode: 'json', shape: 'refreshed', capture: false, scope: 'credential', admitsLapsed: true, mintsAuthority: true, credential: handleRefresh },
  // #1148 — bounded import and backfill
  { authorization: httpPolicy('plan', 'capture', 'project', ['member']), method: 'POST', path: '/import/plan', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleImportPlan },
  // The retained runtime channel binds every operation to its dispatch credential,
  // Project, lifecycle and task capability at the pipeline. It is not member capture.
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/claim', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleClaimRun },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/get', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/get') },
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/update', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleUpdateRun },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/failed', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/failed') },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/resume-admission', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/resume-admission') },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/supersede', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/supersede') },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/reports', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/reports') },
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/report', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleWriteReport },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/events', auth: 'member', legacyRunRoute: true, retired: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: retiredRunRoute('/runs/events') },
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/embedding-step', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleEmbeddingStep },
  { authorization: httpPolicy('spore', 'edit', 'project', ['member']), method: 'POST', path: '/spores/save', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleSaveSpore },
  { authorization: httpPolicy('spore', 'read', 'project', ['member']), method: 'POST', path: '/spores/list', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleListSpores },
  { authorization: httpPolicy('spore', 'read', 'project', ['member']), method: 'POST', path: '/spores/get', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleGetSpore },
  { authorization: httpPolicy('spore', 'edit', 'project', ['member']), method: 'POST', path: '/spores/resolve', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleResolveSpore },
  // What a prompt is served: the plan nudge and the session's unseen spores.
  // `capture: false`: this route answers a read of the Project's own intelligence.
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'POST', path: '/context/prompt', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handlePromptContext },
  // What a starting session or a starting subagent is served: the Project's
  // instructions, and the preferred digest where a Deployment asks for it.
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'POST', path: '/context/session', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, handler: handleSessionContext },
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/repository', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRunRepository },
  { authorization: httpPolicy('run', 'execute', 'run', ['run']), method: 'POST', path: '/runs/canopy-map', auth: 'member', legacyRunRoute: true, bodyMode: 'json', shape: 'persisted', capture: false, handler: handleRunMap },
  // The tool surface: the seven MCP tools over the Deployment for a member, the
  // read-only six for an External Agent grant, answered as JSON-RPC. `answered`
  // is its refusal shape — an error envelope, at 400 or 503.
  // #1151 — worker mode. Deployment-scoped: a worker claims from one queue
  // across every Project, so it names none and the pipeline resolves none. Only
  // an administrator is admitted: a claim answers with a minted run credential
  // and the Deployment's own harness credential.
  { authorization: httpPolicy('queue', 'claim', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/claim', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', mintsAuthority: true, deployment: handleWorkerClaim },
  { authorization: httpPolicy('queue', 'lease', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/lease', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerLease },
  { authorization: httpPolicy('queue', 'lease', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/end', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerEnd },
  { authorization: httpPolicy('queue', 'lease', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/steps', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerSteps },
  { authorization: httpPolicy('queue', 'lease', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/repository', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', mintsAuthority: true, deployment: handleWorkerRepository },
  { authorization: httpPolicy('queue', 'lease', 'deployment', ['member', 'runner']), method: 'POST', path: '/worker/models', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'deployment', deployment: handleWorkerModels },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/mcp', auth: 'member', bodyMode: 'json', shape: 'answered', capture: false, handler: handleMcp, grant: handleGrantMcp, run: handleRunMcp, unbound: handleUnboundMcp },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['enrollment']), method: 'POST', path: '/members/join', auth: 'enroll', handler: handleJoin },
  { authorization: httpPolicy('member', 'bootstrap', 'member', ['member']), method: 'POST', path: '/members/link-github', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, mintsAuthority: true, handler: handleLinkGithub },
  // Deployment Settings as a member's CLI reads them: Deployment-wide, so no Project is read or created; writes stay on the dashboard's admin routes.
  { authorization: httpPolicy('project', 'create', 'deployment', ['member']), method: 'POST', path: '/members/projects', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleCreateMemberProject },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'POST', path: '/members/projects/resolve', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleResolveMemberProject },
  { authorization: httpPolicy('machine-settings', 'capture', 'machine', ['member']), method: 'POST', path: '/members/uncaptured', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleReportUncaptured },
  { authorization: httpPolicy('machine-settings', 'capture', 'machine', ['member']), method: 'POST', path: '/members/uncaptured/state', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleUncapturedState },
  { authorization: httpPolicy('machine-settings', 'capture', 'machine', ['member']), method: 'POST', path: '/members/harnesses/report', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleProvisionedHarnessReport },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'POST', path: '/members/projects/list', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberProjectList },
  { authorization: httpPolicy('settings', 'read', 'deployment', ['member']), method: 'POST', path: '/members/settings', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberSettings },
  // Deployment health as a member's `myco stats` reads it: Deployment-wide facts, the credential's own stored bytes and the transcript retention window, so no Project is read or created.
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'POST', path: '/members/status', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberStatus },
  { authorization: httpPolicy('raw', 'owner', 'deployment', ['member']), method: 'GET', path: '/members/raw-claims', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberRawClaimPreview },
  { authorization: httpPolicy('raw', 'owner', 'deployment', ['member']), method: 'POST', path: '/members/raw-claims', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberRawClaim },
  { authorization: httpPolicy('member', 'read', 'deployment', ['member']), method: 'GET', path: '/members/ownership', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleMemberOwnershipPreview },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/members/ownership', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', mintsAuthority: true, credential: handleMemberOwnership },
  { authorization: httpPolicy('member', 'owner', 'deployment'), method: 'POST', path: '/members/ownership/transfer', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', mintsAuthority: true, credential: handleMemberOwnershipTransfer },
  { authorization: httpPolicy('member', 'read', 'deployment'), method: 'GET', path: '/members/roles', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', credential: handleCredentialRoles },
  { authorization: httpPolicy('member', 'owner', 'deployment'), method: 'POST', path: '/members/roles', auth: 'member', bodyMode: 'json', shape: 'persisted', capture: false, scope: 'credential', mintsAuthority: true, credential: handleCredentialMemberRole },
  { authorization: httpPolicy('member', 'owner', 'deployment'), method: 'POST', path: '/api/ownership/transfer', auth: 'session', authority: 'admin', handler: handleOwnershipTransfer },
  { authorization: httpPolicy('member', 'owner', 'member'), method: 'POST', path: '/api/members/{memberId}/role', pattern: new RegExp(`^/api/members/(?<memberId>${MEMBER_ID_SEGMENT})/role$`), auth: 'session', authority: 'admin', handler: handleMemberRole },
  { authorization: httpPolicy('raw', 'owner', 'deployment', ['member']), method: 'GET', path: '/api/raw-claims', auth: 'session', authority: 'admin', handler: handleRawClaimPreview },
  { authorization: httpPolicy('raw', 'owner', 'deployment', ['member']), method: 'POST', path: '/api/raw-claims', auth: 'session', authority: 'admin', handler: handleRawClaim },
  { authorization: httpPolicy('member', 'read', 'deployment', ['member']), method: 'GET', path: '/api/ownership', auth: 'session', authority: 'member', handler: handleOwnershipPreview },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/ownership', auth: 'session', authority: 'admin', handler: handleOwnership },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['account', 'member']), method: 'GET', path: '/auth/me', auth: 'session', authority: 'account', handler: handleMe },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['account', 'member']), method: 'POST', path: '/auth/link', auth: 'session', authority: 'account', handler: handleLink },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/status', auth: 'session', authority: 'member', handler: handleStatus },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/diagnostics', auth: 'session', authority: 'admin', handler: handleDiagnostics },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/projects', auth: 'session', authority: 'member', handler: handleProjects },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/projects', auth: 'session', authority: 'admin', handler: handleCreateProject },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/archive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/archive$/, auth: 'session', authority: 'admin', handler: handleArchiveProject },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/unarchive', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/unarchive$/, auth: 'session', authority: 'admin', handler: handleUnarchiveProject },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'PATCH', path: '/api/projects/{projectId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})$/, auth: 'session', authority: 'admin', handler: handleRenameProject },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/activity', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'session', authority: 'member', handler: handleProjectActivity },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions$/, auth: 'session', authority: 'member', handler: handleProjectSessions },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})$/, auth: 'session', authority: 'member', handler: handleSession },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/{child}', pattern: new RegExp(String.raw`^/api/projects/(?<projectId>[A-Za-z0-9._-]{1,64})/sessions/(?<sessionId>[^/]{1,384})/(?<child>${CHILD_SEGMENTS.join('|')})$`), auth: 'session', authority: 'member', handler: handleSessionChildren },
  { authorization: httpPolicy('raw-index', 'enumerate', 'raw', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/transcript', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/transcript$/, auth: 'session', authority: 'member', raw: { resource: 'transcript', action: 'enumerate' }, handler: handleTranscript },
  { authorization: httpPolicy('plan', 'status', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/plans/{planKey}/status', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/plans\/(?<planKey>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/status$/, auth: 'session', authority: 'member', handler: handleSetPlanStatus },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/title', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/title$/, auth: 'session', authority: 'admin', handler: handleTitleSession },
  // #1147 — transcript-first ingest
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/tombstone', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/tombstone$/, auth: 'session', authority: 'admin', handler: handleTombstoneSession },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/sessions/{sessionId}/end', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/end$/, auth: 'session', authority: 'admin', handler: handleEndSession },
  // A session as turns: the list, one turn's body, and one turn's tool calls. A prompt id is member-minted under the envelope's id grammar.
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns$/, auth: 'session', authority: 'member', handler: handleSessionTurns },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns/{promptId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns\/(?<promptId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, auth: 'session', authority: 'member', handler: handleSessionTurn },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/sessions/{sessionId}/turns/{promptId}/tool-calls', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/sessions\/(?<sessionId>[^/]{1,384})\/turns\/(?<promptId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/tool-calls$/, auth: 'session', authority: 'member', handler: handleSessionTurnToolCalls },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/processed/{kind}/{id}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/processed\/(?<kind>prompt|response|plan|tool-input|tool-output|attachment)\/(?<id>[^/]{1,384})$/, auth: 'session', authority: 'member', handler: handleProcessedBody },
  { authorization: httpPolicy('raw', 'read', 'raw', ['member']), method: 'GET', path: '/api/projects/{projectId}/blobs/{key}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/blobs\/(?<key>[0-9a-f]{64})$/, auth: 'session', authority: 'member', raw: { resource: 'blob', action: 'read' }, handler: handleBlobRead },
  { authorization: httpPolicy('directory', 'read', 'deployment', ['member']), method: 'GET', path: '/api/members', auth: 'session', authority: 'member', handler: handleMembers },
  { authorization: httpPolicy('member', memberRevocationAction, 'member', ['member']), method: 'POST', path: '/api/members/{memberId}/revoke', pattern: new RegExp(`^\\/api\\/members\\/(?<memberId>${MEMBER_ID_SEGMENT})\\/revoke$`), auth: 'session', authority: 'admin', handler: handleRevokeMember },
  { authorization: httpPolicy('member', 'admin', 'member', ['member']), method: 'POST', path: '/api/members/{memberId}/link-github', pattern: new RegExp(`^\\/api\\/members\\/(?<memberId>${MEMBER_ID_SEGMENT})\\/link-github$`), auth: 'session', authority: 'admin', handler: handleIssueMemberLink },
  { authorization: httpPolicy('enrollment', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/enrollment', auth: 'session', authority: 'admin', handler: handleInvitations },
  { authorization: httpPolicy('enrollment', invitationAction, 'enrollment'), method: 'POST', path: '/api/enrollment', auth: 'session', authority: 'admin', handler: handleMintInvitation },
  { authorization: httpPolicy('enrollment', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/enrollment/{id}/revoke', pattern: /^\/api\/enrollment\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'admin', handler: handleRevokeInvitation },
  { authorization: httpPolicy('credential', 'read', 'deployment', ['member']), method: 'GET', path: '/api/credentials', auth: 'session', authority: 'member', handler: handleCredentials },
  { authorization: httpPolicy('credential', 'edit', 'credential', ['member']), method: 'POST', path: '/api/credentials/{id}/revoke', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'member', handler: handleRevokeCredential },
  { authorization: httpPolicy('credential', 'read', 'credential', ['member']), method: 'GET', path: '/api/credentials/{id}/activity', pattern: /^\/api\/credentials\/(?<id>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'session', authority: 'member', handler: handleCredentialActivity },
  { authorization: httpPolicy('grant', 'admin', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'session', authority: 'admin', handler: handleGrants },
  { authorization: httpPolicy('grant', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/grants', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants$/, auth: 'session', authority: 'admin', handler: handleMintGrant },
  { authorization: httpPolicy('grant', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/rotate', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/rotate$/, auth: 'session', authority: 'admin', handler: handleRotateGrant },
  { authorization: httpPolicy('grant', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/grants/{grantId}/revoke', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/grants\/(?<grantId>[A-Za-z0-9._-]{1,64})\/revoke$/, auth: 'session', authority: 'admin', handler: handleRevokeGrant },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/agents', auth: 'session', authority: 'member', handler: handleAgents },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PUT', path: '/api/agents/{agentId}', pattern: /^\/api\/agents\/(?<agentId>[A-Za-z0-9._-]{1,64})$/, auth: 'session', authority: 'admin', handler: handleRegisterAgent },
  { authorization: httpPolicy('run', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/runs', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs$/, auth: 'session', authority: 'member', handler: handleProjectRuns },
  { authorization: httpPolicy('run', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/runs/{runId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})$/, auth: 'session', authority: 'member', handler: handleProjectRun },
  { authorization: httpPolicy('run', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/runs/{runId}/calls', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})\/calls$/, auth: 'session', authority: 'member', handler: handleProjectRunCalls },
  { authorization: httpPolicy('run', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/runs/{runId}/steps', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/runs\/(?<runId>[^/]{1,384})\/steps$/, auth: 'session', authority: 'member', handler: handleProjectRunSteps },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/cortex/instructions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/cortex\/instructions$/, auth: 'session', authority: 'member', handler: handleProjectInstructions },
  { authorization: httpPolicy('plan', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/plans', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/plans$/, auth: 'session', authority: 'member', handler: handleProjectPlans },
  { authorization: httpPolicy('plan', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/plans/{planKey}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/plans\/(?<planKey>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/, auth: 'session', authority: 'member', handler: handleProjectPlan },
  { authorization: httpPolicy('spore', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/spores', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores$/, auth: 'session', authority: 'member', handler: handleProjectSpores },
  { authorization: httpPolicy('spore', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/spores/{sporeId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/spores\/(?<sporeId>[^/]{1,192})$/, auth: 'session', authority: 'member', handler: handleProjectSpore },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/skills', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills$/, auth: 'session', authority: 'member', handler: handleProjectSkills },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/skill-candidates', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skill-candidates$/, auth: 'session', authority: 'member', handler: handleSkillCandidates },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'PATCH', path: '/api/projects/{projectId}/skill-candidates/{candidateId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skill-candidates\/(?<candidateId>[^/]{1,192})$/, auth: 'session', authority: 'admin', handler: handleReviewSkillCandidate },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/skills/{skillId}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/skills\/(?<skillId>[^/]{1,192})$/, auth: 'session', authority: 'member', handler: handleProjectSkill },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/digests', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests$/, auth: 'session', authority: 'member', handler: handleProjectDigests },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/digests/{tier}/revisions', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/digests\/(?<tier>\d{1,6})\/revisions$/, auth: 'session', authority: 'member', handler: handleProjectDigestRevisions },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/release-states', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-states$/, auth: 'session', authority: 'member', handler: handleProjectReleaseStates },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/recovery/exports', auth: 'session', authority: 'admin', handler: handleStartRecoveryExport },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/recovery/exports', auth: 'session', authority: 'admin', handler: handleRecoveryExportStatus },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/recovery/exports/forget-unsettled', auth: 'session', authority: 'admin', handler: handleForgetUnsettledExport },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/backups', auth: 'session', authority: 'admin', handler: handleCreateBackup },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/backups', auth: 'session', authority: 'admin', handler: handleListBackups },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/backups/{backupId}/restore-preview', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore-preview$/, auth: 'session', authority: 'admin', handler: handleRestorePreview },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/backups/{backupId}/restore', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/restore$/, auth: 'session', authority: 'admin', handler: handleRestoreBackup },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/backups/{backupId}/pin', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/pin$/, auth: 'session', authority: 'admin', handler: handlePinBackup },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/backups/{backupId}/artifact', pattern: /^\/api\/backups\/(?<backupId>[A-Za-z0-9._-]{1,64})\/artifact$/, auth: 'session', authority: 'admin', handler: handleBackupArtifact },
  { authorization: httpPolicy('backup', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/backups/restore-upload', auth: 'session', authority: 'admin', maxBodyBytes: MAX_UPLOAD_BODY_BYTES, handler: handleRestoreUpload },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/kpis', auth: 'session', authority: 'member', handler: handleKpis },
  // Today (#1518): the three lists across Projects, Myco's work over a window, and what needs an administrator.
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/sessions', auth: 'session', authority: 'member', handler: handleSessionsAcross },
  { authorization: httpPolicy('spore', 'read', 'deployment', ['member']), method: 'GET', path: '/api/spores', auth: 'session', authority: 'member', handler: handleSporesAcross },
  { authorization: httpPolicy('plan', 'read', 'deployment', ['member']), method: 'GET', path: '/api/plans', auth: 'session', authority: 'member', handler: handlePlansAcross },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/search', auth: 'session', authority: 'member', handler: handleSearchAcross },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/tasks/names', auth: 'session', authority: 'member', handler: handleTaskNames },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/tasks/start', auth: 'session', authority: 'member', handler: handleTaskStartPreview },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/tasks', auth: 'session', authority: 'member', handler: handleTaskDescriptions },
  { authorization: httpPolicy('processed', 'read', 'deployment', ['member']), method: 'GET', path: '/api/work', auth: 'session', authority: 'member', handler: handleWork },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/attention', auth: 'session', authority: 'admin', handler: handleAttention },
  { authorization: httpPolicy('settings', 'read', 'deployment', ['member']), method: 'GET', path: '/api/settings', auth: 'session', authority: 'member', handler: handleSettings },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PUT', path: '/api/settings/{leaf}', pattern: /^\/api\/settings\/(?<leaf>[A-Za-z0-9._-]{1,96})$/, auth: 'session', authority: 'admin', handler: handleSetSetting },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/settings/agent.tasks/repair', auth: 'session', authority: 'admin', handler: handleRepairTaskDocument },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PATCH', path: '/api/settings/agent.tasks', auth: 'session', authority: 'admin', handler: handleSetTaskTier },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'PUT', path: '/api/embedding', auth: 'session', authority: 'admin', handler: handleSetEmbedding },
  { authorization: httpPolicy('settings', 'read', 'deployment', ['member']), method: 'GET', path: '/api/embedding/switch', auth: 'session', authority: 'member', handler: handleEmbeddingSwitch },
  { authorization: httpPolicy('settings', 'read', 'deployment', ['member']), method: 'GET', path: '/api/embedding/passed-over', auth: 'session', authority: 'member', handler: handlePassedOverSources },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/embedding/switch', auth: 'session', authority: 'admin', handler: handleStartEmbeddingSwitch },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/embedding/switch/estimate', auth: 'session', authority: 'admin', handler: handleEstimateEmbeddingSwitch },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'DELETE', path: '/api/embedding/switch/{switchId}', pattern: /^\/api\/embedding\/switch\/(?<switchId>[A-Za-z0-9_-]{1,64})$/, auth: 'session', authority: 'admin', handler: handleCancelEmbeddingSwitch },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'POST', path: '/api/embedding/switch/{switchId}/resume', pattern: /^\/api\/embedding\/switch\/(?<switchId>[A-Za-z0-9_-]{1,64})\/resume$/, auth: 'session', authority: 'admin', handler: handleResumeEmbeddingSwitch },
  { authorization: httpPolicy('settings', 'admin', 'deployment', ['member']), method: 'DELETE', path: '/api/settings/{leaf}', pattern: /^\/api\/settings\/(?<leaf>[A-Za-z0-9._-]{1,96})$/, auth: 'session', authority: 'admin', handler: handleResetSetting },
  { authorization: httpPolicy('secret', 'admin', 'deployment', ['member']), method: 'GET', path: '/api/secrets', auth: 'session', authority: 'admin', handler: handleSecrets },
  { authorization: httpPolicy('secret', 'admin', 'deployment', ['member']), method: 'PUT', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'session', authority: 'admin', handler: handleSetSecret },
  { authorization: httpPolicy('secret', 'admin', 'deployment', ['member']), method: 'DELETE', path: '/api/secrets/{name}', pattern: /^\/api\/secrets\/(?<name>[a-z0-9_-]{1,32})$/, auth: 'session', authority: 'admin', handler: handleDeleteSecret },
  { authorization: httpPolicy('processed', 'read', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/capabilities', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities$/, auth: 'session', authority: 'member', handler: handleProjectCapabilities },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleRepository },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'PUT', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleSaveRepository },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'DELETE', path: '/api/projects/{projectId}/repository', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/repository$/, auth: 'session', authority: 'admin', handler: handleRemoveRepository },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'GET', path: '/api/projects/{projectId}/release-provenance', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance$/, auth: 'session', authority: 'admin', handler: handleReleaseProvenance },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'PUT', path: '/api/projects/{projectId}/release-provenance', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance$/, auth: 'session', authority: 'admin', handler: handleSaveReleaseProvenance },
  { authorization: httpPolicy('secret', 'admin', 'project', ['member']), method: 'POST', path: '/api/projects/{projectId}/release-provenance/check', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/release-provenance\/check$/, auth: 'session', authority: 'admin', handler: handleRequestReleaseCheck },
  { authorization: httpPolicy('settings', 'admin', 'project', ['member']), method: 'PUT', path: '/api/projects/{projectId}/capabilities/{capability}', pattern: /^\/api\/projects\/(?<projectId>[A-Za-z0-9._-]{1,64})\/capabilities\/(?<capability>[a-z_]{1,32})$/, auth: 'session', authority: 'admin', handler: handleSetProjectCapability },
  // A machine's own settings (#1393): any member may ask, and the handlers answer only the member who claims the machine.
  { authorization: httpPolicy('machine', 'read', 'deployment', ['member']), method: 'GET', path: '/api/machines', auth: 'session', authority: 'member', handler: handleMachines },
  { authorization: httpPolicy('machine', 'read', 'machine', ['member']), method: 'GET', path: '/api/machines/{machineId}/activity', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/activity$/, auth: 'session', authority: 'member', handler: handleMachineActivity },
  { authorization: httpPolicy('credential', 'edit', 'machine', ['member']), method: 'POST', path: '/api/machines/{machineId}/stop', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/stop$/, auth: 'session', authority: 'member', handler: handleStopMachine },
  { authorization: httpPolicy('machine', 'read', 'deployment', ['member']), method: 'GET', path: '/api/uncaptured', auth: 'session', authority: 'member', handler: handleListUncaptured },
  { authorization: httpPolicy('machine-settings', 'claimant.edit', 'machine', ['member']), method: 'POST', path: '/api/uncaptured/{machineId}/{rootKey}/connect', pattern: /^\/api\/uncaptured\/(?<machineId>[A-Za-z0-9._-]{1,64})\/(?<rootKey>[0-9a-f]{16,64})\/connect$/, auth: 'session', authority: 'member', handler: handleConnectUncaptured },
  { authorization: httpPolicy('machine', 'edit', 'machine', ['member']), method: 'PATCH', path: '/api/machines/{machineId}', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})$/, auth: 'session', authority: 'member', handler: handleRenameMachine },
  { authorization: httpPolicy('machine-settings', 'claimant.read', 'machine', ['member']), method: 'GET', path: '/api/machines/{machineId}/settings', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/settings$/, auth: 'session', authority: 'member', handler: handleMachineSettings },
  { authorization: httpPolicy('machine-settings', 'claimant.edit', 'machine', ['member']), method: 'PUT', path: '/api/machines/{machineId}/settings/{leaf}', pattern: /^\/api\/machines\/(?<machineId>[A-Za-z0-9._-]{1,64})\/settings\/(?<leaf>[A-Za-z0-9._]{1,96})$/, auth: 'session', authority: 'member', handler: handleSetMachineSetting },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['public']), method: 'GET', path: '/auth/login', auth: 'auth', handler: handleLogin },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['public']), method: 'GET', path: '/auth/callback', auth: 'auth', handler: handleCallback },
  { authorization: httpPolicy('protocol', 'protocol', 'protocol', ['account', 'member']), method: 'POST', path: '/auth/logout', auth: 'session', authority: 'account', handler: async () => new Response(null, { status: 204, headers: { 'set-cookie': clearCookie() } }) },
];

/** A 1.4.x wire route the server does not serve; each names the event kinds (or the blob route) that carry the same capture in 2.0, or says what it carried is gone. A retired path is unmatched and answers 401 like any other absent path. */
export interface RetiredRoute {
  authorization: AuthorizationDeclaration;
  method: string;
  path: string;
  replacedBy: readonly string[];
  /** What the route carried is dropped rather than replaced, and by which child. */
  dropped?: string;
}

export const RETIRED_ROUTES: readonly RetiredRoute[] = [
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/sessions/register', replacedBy: ['session.start'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/sessions/unregister', replacedBy: ['session.end'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/events/stop', replacedBy: ['response'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/events/sync-transcript-prompts', replacedBy: ['prompt'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/routed-capture/transcript', replacedBy: ['POST /blobs/{sha256}', 'transcript.segment'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/routed-capture/plan', replacedBy: ['plan'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/context/subagent', replacedBy: ['subagent.start'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/cortex-instructions', replacedBy: ['PUT /api/settings/{leaf}'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/instruction', replacedBy: ['POST /worker/claim'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/digest', replacedBy: ['GET /api/projects/{projectId}/digests'] },
  { authorization: httpPolicy('protocol', 'never', 'protocol', ['member', 'run', 'grant']), method: 'POST', path: '/runs/digest-write', replacedBy: [], dropped: 'the generated digest goes (plan §3 D2, #1152); stored digests stay readable until #1170 drops the table' },
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
