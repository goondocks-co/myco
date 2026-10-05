import type { ReleaseStatus } from './use-release-provenance';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, postJson, SignedOutError } from '../lib/api';
import { usePaged } from './use-paged';
import type { ResumeCommand, SessionListPage, SessionListRow, SessionOutcome } from '../features/sessions/wire';
import { isLive, LIVE_WITHIN_MS } from '../features/today/timeline';
import { LIVE_REFRESH_MS } from './use-work';

export interface SessionRow {
  sessionId: string;
  machineId: string | null;
  createdByTokenId: string;
  firstReceivedAt: number;
  lastReceivedAt: number;
  agent: string | null;
  branch: string | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The member whose End session applied the standing end; null for an end the agent or an import applied. */
  endedBy: string | null;
  endedByLabel: string | null;
  originPath: string | null;
  parentSessionId: string | null;
  parentReason: string | null;
  memberId: string | null;
  memberLabel: string | null;
  runtimeLabel: string | null;
  runtimeKind: string | null;
  /** Written on the server once the session ended and a model looked at it; null until then. */
  title: string | null;
  summary: string | null;
  titledAt: number | null;
  /** What a list or a header shows: the title, else the opening line of the first prompt, else the agent, else the id. */
  label: string;
}

export interface SessionCounts {
  prompts: number;
  toolCalls: number;
  responses: number;
  plans: number;
  attachments: number;
}

/** Why an ended session has no title yet; the server's reason, in its own vocabulary. */
export type UntitledReason = 'capture_pending' | 'no_material' | 'in_progress' | 'stopped' | 'imported' | 'waiting';

/** Each untitled reason in the reader's words. */
export const UNTITLED_REASON_TEXT: Record<UntitledReason, string> = {
  capture_pending: 'Untitled: the transcript is still being processed',
  no_material: 'Untitled: nothing was typed in this session to title',
  in_progress: 'Untitled: a title is being written',
  stopped: 'Untitled: Myco stopped trying to title it on its own. An admin can ask again from the session’s menu',
  imported: 'Untitled: imported sessions get a title once titling imported sessions is turned on',
  waiting: 'Untitled: will be tried automatically soon',
};

export interface SessionResponse {
  session: SessionRow;
  /** Why the ended session has no title; null when it has one or is still open. */
  untitled?: UntitledReason | null;
  counts: SessionCounts;
  /** Whether the session's work is released, or null when it has no release state. */
  release?: ReleaseStatus | null;
  /** What came of the session: the runs that read it or wrote from it, and the spores written from it. */
  outcome: SessionOutcome;
  /** How to pick the session up again in its agent: `line` is what to paste, the folder entered first. Null when its agent can't resume it. */
  resume?: ResumeCommand | null;
  projectId: string;
}

export interface PromptRow {
  promptId: string;
  text: string | null;
  blobKey: string | null;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface ToolCallRow {
  toolCallId: string;
  promptId: string | null;
  toolName: string;
  mycoTool: string | null;
  mycoOp: string | null;
  inputPreview: string | null;
  inputBytes: number | null;
  inputBlobKey: string | null;
  outputPreview: string | null;
  outputBlobKey: string | null;
  success: boolean;
  errorMessage: string | null;
  durationMs: number | null;
  filesAffected: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface ResponseRow {
  responseId: string;
  promptId: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
  orderedAt: number;
}

/** A captured plan. `promptId` names the turn that produced it; `progress` is `checked/total` over its task list or `N/A`; `updatedBy` is the member behind its last status change, null when a capture wrote last. */
export interface PlanRow {
  planKey: string;
  promptId: string | null;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  /** The file or the tag the plan came from, as the capture named it. */
  originPath: string | null;
  progress: string;
  updatedBy: string | null;
  createdAt: number;
  updatedAt: number;
  orderedAt: number;
}

/** The fields a plan card renders. Every plan surface carries these; the session ordering is the session timeline's alone. */
export type PlanCardRow = Omit<PlanRow, 'orderedAt'>;

/** The statuses a person may set on a plan, in the order the control lists them. */
export const PLAN_STATUSES = ['active', 'in_progress', 'completed', 'abandoned'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];

export interface AttachmentRow {
  attachmentId: string;
  /** The prompt the attachment accompanies, when the capture named one. */
  promptId: string | null;
  blobKey: string;
  mediaType: string;
  byteSize: number;
  description: string | null;
  createdAt: number;
  orderedAt: number;
}

export interface TranscriptSegment { baseOffset: number; length: number; blobKey: string; createdAt: number }

export interface TranscriptRecord {
  transcriptId: string;
  sessionId: string;
  machineId: string;
  agent: string | null;
  originPath: string | null;
  size: number;
  segmentCount: number;
  firstReceivedAt: number;
  lastReceivedAt: number;
  /** The session's own transcript, or a subagent's beside it. */
  role: string;
  /** How far the server has read it, and what its format could carry. */
  parsedOffset: number;
  parsedAt: number | null;
  fidelity: string | null;
  parseError: string | null;
  parseFailedAt: number | null;
  segments: TranscriptSegment[];
}

export interface TranscriptResponse {
  /** The session's own transcript. */
  transcript: TranscriptRecord;
  /** Every transcript the session holds, the primary first; a subagent adds one beside it. */
  transcripts: TranscriptRecord[];
  segments: TranscriptSegment[];
}

export type SessionChild = 'prompts' | 'tool-calls' | 'responses' | 'plans' | 'attachments' | 'context-injections';
export interface ContextInjectionRow { kind: string; createdAt: number; orderedAt: number }

/** The origins a prompt can carry on the wire. A person's own prompts are `user`; the rest are what a runtime injected around them. */
export const PROMPT_ORIGINS = ['user', 'system', 'agent_dispatch', 'hook_injected', 'unknown'] as const;
export type PromptOrigin = (typeof PROMPT_ORIGINS)[number];

/** One top-level prompt of a session and counts of what followed it; the list the timeline renders collapsed. */
export interface TurnRow {
  promptId: string;
  origin: string;
  promptKind: string | null;
  threadLabel: string | null;
  /** The opening of the inline text; null when the text spilled to a blob. */
  preview: string | null;
  textChars: number | null;
  blobKey: string | null;
  createdAt: number;
  toolCallCount: number;
  responseCount: number;
  childCount: number;
  planCount: number;
  attachmentCount: number;
}

export interface TurnPrompt {
  promptId: string;
  origin: string;
  promptKind: string | null;
  parentPromptId: string | null;
  threadLabel: string | null;
  text: string | null;
  blobKey: string | null;
  createdAt: number;
}

export interface TurnChild {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  toolCallCount: number;
  responsesCursor?: string | null;
}

/** One observation Myco added to a prompt. */
export interface InjectedSpore {
  id: string;
  observationType: string;
  preview: string;
}

/** What Myco added to a prompt: the observations it served, and when. */
export interface TurnInjection {
  sporeIds: string[];
  createdAt: number;
  spores: InjectedSpore[];
}

/** One turn's body; its tool calls are read on their own when opened. */
export interface TurnDetail {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  attachments: AttachmentRow[];
  /** The plans this turn produced. */
  plans: PlanRow[];
  /** The observations Myco added to this prompt, or null when it added none. */
  injection: TurnInjection | null;
  children: TurnChild[];
  cursors?: Record<TurnCollection, string | null>;
}

export type TurnCollection = 'responses' | 'attachments' | 'plans' | 'children';

/** The image types the blob route serves with their stored type; anything else is served as a download and cannot render inline. */
export const RENDERABLE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const seg = (value: string) => encodeURIComponent(value);
const project = (projectId: string) => `/api/projects/${seg(projectId)}`;

const RAW_READ_CACHE_VERSION = 71;
export const blobUrl = (projectId: string, key: string) => `${project(projectId)}/blobs/${seg(key)}?raw=${RAW_READ_CACHE_VERSION}`;

export type ProcessedBodyKind = 'prompt' | 'response' | 'plan' | 'tool-input' | 'tool-output' | 'attachment';
export interface ProcessedBodyRef { kind: ProcessedBodyKind; id: string }
export const processedBodyUrl = (projectId: string, ref: ProcessedBodyRef) => `${project(projectId)}/processed/${ref.kind}/${seg(ref.id)}`;

/** What the table asks the list for; each narrows the list on the server. */
export interface SessionListFilters {
  /** One Project, or null for every Project. */
  projectId: string | null;
  /** `open` is a session with no end recorded; `ended` one with an end. */
  state?: 'open' | 'ended';
  /** Matched by the server over the title, the first prompt, the agent, the branch and the id. */
  q?: string;
  agent?: string;
  /** A member's label, as the server matches it. */
  member?: string;
  branch?: string;
  /** The sessions active in `[since, until)`: started before `until`, heard from since `since`, and not ended before it. */
  active?: { since: number; until?: number };
}

/** How many sessions one page of the table holds. */
export const SESSION_PAGE = 50;

/** The path of the session list for a set of filters. */
export function sessionListPath(filters: SessionListFilters): string {
  const params = new URLSearchParams({ limit: String(SESSION_PAGE) });
  if (filters.projectId !== null) params.set('project', filters.projectId);
  if (filters.state !== undefined) params.set('state', filters.state);
  if (filters.q !== undefined && filters.q.trim() !== '') params.set('q', filters.q.trim());
  if (filters.agent !== undefined && filters.agent !== '') params.set('agent', filters.agent);
  if (filters.member !== undefined && filters.member !== '') params.set('member', filters.member);
  if (filters.branch !== undefined && filters.branch !== '') params.set('branch', filters.branch);
  if (filters.active !== undefined) {
    params.set('window', 'activity');
    params.set('since', String(filters.active.since));
    if (filters.active.until !== undefined) params.set('until', String(filters.active.until));
  }
  return `/api/sessions?${params}`;
}

/** The sessions the table lists, newest start first, a page at a time. It is read again on focus and on a change, never on a timer. */
export function useSessionList(filters: SessionListFilters) {
  const path = sessionListPath(filters);
  // Sessions order by a date the parse revises, so one session can reach two pages.
  return usePaged<SessionListRow>(['sessions', filters.projectId ?? 'all', path], path, {
    rowKey: (row) => `${row.projectId}/${row.sessionId}`,
  });
}

/**
 * The sessions live now under the table's filters: open, and heard from within
 * the live span, read as one page. While it holds any, it is read again every
 * 30 s, never from a hidden tab; the span is taken at each read.
 */
export function useLiveSessions(filters: Omit<SessionListFilters, 'state' | 'active'>, enabled: boolean) {
  const scope = sessionListPath({ ...filters, state: 'open' });
  return useQuery({
    queryKey: ['sessions', 'live', filters.projectId ?? 'all', scope],
    enabled,
    queryFn: ({ signal }) => fetchJson<SessionListPage>(sessionListPath({ ...filters, state: 'open', active: { since: Date.now() - LIVE_WITHIN_MS } }), signal),
    refetchInterval: (query) => ((query.state.data?.rows.length ?? 0) > 0 ? LIVE_REFRESH_MS : false),
    refetchIntervalInBackground: false,
  });
}

/** A named turn or its steering parent, resolved without walking prior pages. */
export function useNamedTurn(projectId: string, sessionId: string, promptId: string | null) {
  return useQuery({
    queryKey: ['turns', projectId, sessionId, 'named', promptId],
    enabled: promptId !== null,
    queryFn: ({ signal }) => fetchJson<{ rows: TurnRow[]; cursor: string | null }>(`${project(projectId)}/sessions/${seg(sessionId)}/turns?origins=${PROMPT_ORIGINS.join(',')}&turn=${seg(promptId!)}`, signal),
  });
}

/** How many turns one page of the conversation's read holds. */
export const TURN_PAGE = 200;

/** A session's turns, newest first; the origins sit in the key so a toggle shows only that list's pages. */
export function useTurns(projectId: string, sessionId: string, origins: readonly PromptOrigin[]) {
  const named = [...origins].sort().join(',');
  return usePaged<TurnRow>(['turns', projectId, sessionId, named], `${project(projectId)}/sessions/${seg(sessionId)}/turns?origins=${encodeURIComponent(named)}&limit=${TURN_PAGE}&order=desc`);
}

/** One turn's body, read when its card opens. */
export function useTurnDetail(projectId: string, sessionId: string, promptId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['turn', projectId, sessionId, promptId],
    enabled,
    queryFn: ({ signal }) => fetchJson<TurnDetail>(`${project(projectId)}/sessions/${seg(sessionId)}/turns/${seg(promptId)}`, signal),
  });
}

/** One turn's tool calls, read when the reader opens them. */
export function useTurnToolCalls(projectId: string, sessionId: string, promptId: string, enabled: boolean) {
  return usePaged<ToolCallRow>(['turn-tool-calls', projectId, sessionId, promptId], `${project(projectId)}/sessions/${seg(sessionId)}/turns/${seg(promptId)}/tool-calls?limit=200`, { enabled });
}

/** What the server answers when asked to title a session now: a run was started, or why none was; each names an outcome in the reader's words. */
export type TitlingOutcome =
  | 'dispatched' | 'already' | 'no_material' | 'harness_unavailable' | 'error' | 'queued' | 'capture_pending';

export const TITLING_OUTCOME_TEXT: Record<TitlingOutcome, string> = {
  dispatched: 'A new title is being written; it lands within a few minutes',
  queued: 'The new title is waiting for a machine; it starts as one frees up',
  already: 'A title was asked for a moment ago; try again shortly',
  no_material: 'Nothing was typed in this session to title yet',
  capture_pending: 'Capture is incomplete. Check the session transcript before retrying.',
  harness_unavailable: 'Myco has no way to write titles here yet',
  error: 'Something went wrong starting the title',
};

/** How long the page keeps watching for a dispatched summary to land: the run's own bound plus the margin its container is held for. */
export const TITLING_WATCH_MS = (300 + 120) * 1000;

export interface TitlingAnswer {
  outcome: TitlingOutcome;
  /** The run that will write the title, on `dispatched`. */
  runId?: string;
}

/** Asks the server to title the session now; on an answer, the session's facts are read again. */
export function useTitleSession(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<TitlingAnswer>(`${project(projectId)}/sessions/${seg(sessionId)}/title`),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['session', projectId, sessionId] }),
      client.invalidateQueries({ queryKey: ['sessions'] }),
    ]),
  });
}

/** Ends an open session now; on an answer, the session, the session lists and Today are read again. */
export function useEndSession(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ outcome: 'ended' | 'already_ended' | 'open'; endedAt: number | null }>(`${project(projectId)}/sessions/${seg(sessionId)}/end`),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['session', projectId, sessionId] }),
      client.invalidateQueries({ queryKey: ['sessions'] }),
      client.invalidateQueries({ queryKey: ['today'] }),
    ]),
  });
}

export function useDeleteSession() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, sessionId }: { projectId: string; sessionId: string }) =>
      postJson<{ applied: boolean; removed: number; blobsFreed: number; blobsLeft: number }>(`${project(projectId)}/sessions/${seg(sessionId)}/tombstone`, {}),
    onSuccess: async (_, { projectId }) => {
      await client.invalidateQueries({ predicate: (query) => query.queryKey[1] === projectId, refetchType: 'none' });
      await Promise.all([
        ...['sessions', 'today', 'projects', 'status', 'plans', 'spore-stream', 'search'].map((key) => client.invalidateQueries({ queryKey: [key] })),
      ]);
    },
  });
}

/** Sets a plan's status as the signed-in member; on an answer, the session's plans, the turn that produced it, the session's counts, the plan's page and the plans board are read again. */
export function useSetPlanStatus(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ planKey, status }: { planKey: string; status: PlanStatus }) =>
      postJson<{ plan: PlanRow }>(`${project(projectId)}/sessions/${seg(sessionId)}/plans/${seg(planKey)}/status`, { status }),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['session-children', projectId, sessionId, 'plans'] }),
      client.invalidateQueries({ queryKey: ['turn', projectId, sessionId] }),
      client.invalidateQueries({ queryKey: ['session', projectId, sessionId] }),
      client.invalidateQueries({ queryKey: ['plan', projectId] }),
      client.invalidateQueries({ queryKey: ['plans'] }),
      client.invalidateQueries({ queryKey: ['search'] }),
    ]),
  });
}

/** One session and what came of it. While the session is live it is read again every 30 s, never from a hidden tab. */
export function useSession(projectId: string, sessionId: string) {
  return useQuery({
    queryKey: ['session', projectId, sessionId],
    queryFn: ({ signal }) => fetchJson<SessionResponse>(`${project(projectId)}/sessions/${seg(sessionId)}`, signal),
    refetchInterval: (query) => (query.state.data !== undefined && isLive(query.state.data.session, Date.now()) ? LIVE_REFRESH_MS : false),
    refetchIntervalInBackground: false,
  });
}

export function useSessionChildren<T>(projectId: string, sessionId: string, child: SessionChild) {
  return usePaged<T>(['session-children', projectId, sessionId, child], `${project(projectId)}/sessions/${seg(sessionId)}/${child}?limit=100`);
}

/** The transcript record, or null when the session has none — the one 404 here that is an answer rather than an error. */
export function useTranscript(projectId: string, sessionId: string) {
  return useQuery({
    queryKey: ['transcript', projectId, sessionId],
    queryFn: async ({ signal }) => {
      try {
        return await fetchJson<TranscriptResponse>(`${project(projectId)}/sessions/${seg(sessionId)}/transcript`, signal);
      } catch (err) {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }
    },
  });
}


/** A processed row's complete field, resolved by its identity rather than its storage hash. */
export function useProcessedText(projectId: string, ref: ProcessedBodyRef, revision: string) {
  return useQuery({
    queryKey: ['processed-text', projectId, ref.kind, ref.id, revision],
    queryFn: async ({ signal }) => {
      const res = await fetch(processedBodyUrl(projectId, ref), { credentials: 'same-origin', signal });
      if (res.status === 401) throw new SignedOutError();
      if (!res.ok) throw new ApiError(res.status, null);
      return res.text();
    },
  });
}
