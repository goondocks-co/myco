import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, fetchJson, postJson, SignedOutError } from '../lib/api';
import { usePaged } from './use-paged';

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

export interface SessionResponse {
  session: SessionRow;
  counts: SessionCounts;
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

export interface PlanRow {
  planKey: string;
  title: string | null;
  status: string;
  content: string | null;
  blobKey: string | null;
  createdAt: number;
  updatedAt: number;
  orderedAt: number;
}

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

export interface TranscriptResponse {
  transcript: {
    transcriptId: string;
    sessionId: string;
    machineId: string;
    agent: string | null;
    originPath: string | null;
    size: number;
    segmentCount: number;
    firstReceivedAt: number;
    lastReceivedAt: number;
  };
  segments: { baseOffset: number; length: number; blobKey: string; createdAt: number }[];
}

export interface FeedItem {
  type: 'session' | 'run' | 'spore';
  id: string;
  summary: string;
  at: number;
  sessionId: string | null;
}

export interface ProjectStats {
  sessions: number;
  openSessions: number;
  sessionsLast7d: number;
  prompts: number;
  toolCalls: number;
  plans: number;
  attachments: number;
  lastActivityAt: number | null;
}

export type SessionChild = 'prompts' | 'tool-calls' | 'responses' | 'plans' | 'attachments';

/** A session row as the list serves it: the row plus its counts and its activity spread over eight lifetime buckets, oldest first. */
export interface SessionSummaryRow extends SessionRow {
  promptCount: number;
  toolCallCount: number;
  activityBuckets: number[];
}

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
}

/** One turn's body; its tool calls are read on their own when opened. */
export interface TurnDetail {
  prompt: TurnPrompt;
  responses: ResponseRow[];
  attachments: AttachmentRow[];
  children: TurnChild[];
}

/** The image types the blob route serves with their stored type; anything else is served as a download and cannot render inline. */
export const RENDERABLE_IMAGE_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const seg = (value: string) => encodeURIComponent(value);
const project = (projectId: string) => `/api/projects/${seg(projectId)}`;

/** Who captured a session, in the words the reader knows: the member's label, then the member id, then the credential id. */
export const memberName = (s: SessionRow): string => s.memberLabel ?? s.memberId ?? s.createdByTokenId;
export const runtimeName = (s: SessionRow): string | null => s.runtimeLabel ?? s.runtimeKind;

export const blobUrl = (projectId: string, key: string) => `${project(projectId)}/blobs/${seg(key)}`;

/** What the rail asks the list for. `state` narrows to open or ended sessions; `q` is the text the filter box holds, matched by the server over title, first prompt, agent, branch and id. */
export interface SessionListFilters {
  state?: 'open' | 'ended';
  q?: string;
  branch?: string;
  member?: string;
}

export function useSessions(projectId: string, filters: SessionListFilters = {}) {
  const params = new URLSearchParams({ limit: '50' });
  if (filters.state !== undefined) params.set('state', filters.state);
  if (filters.q !== undefined && filters.q.trim() !== '') params.set('q', filters.q.trim());
  if (filters.branch !== undefined && filters.branch !== '') params.set('branch', filters.branch);
  if (filters.member !== undefined && filters.member !== '') params.set('member', filters.member);
  return usePaged<SessionSummaryRow>(['sessions', projectId, params.toString()], `${project(projectId)}/sessions?${params.toString()}`);
}

/** A session's turns of the named origins, oldest first. One page holds every turn a person typed in any session seen so far; the origins sit in the key so a toggle never shows the other list's pages. */
export function useTurns(projectId: string, sessionId: string, origins: readonly PromptOrigin[]) {
  const named = [...origins].sort().join(',');
  return usePaged<TurnRow>(['turns', projectId, sessionId, named], `${project(projectId)}/sessions/${seg(sessionId)}/turns?origins=${encodeURIComponent(named)}&limit=200`);
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

/** What the server answers when asked to title a session now; each names an outcome in the reader's words. */
export type TitlingOutcome =
  | 'already' | 'budget' | 'no_material' | 'no_provider' | 'no_credential' | 'local_provider' | 'no_endpoint' | 'no_model'
  | 'malformed' | 'provider' | 'unreachable' | 'superseded' | 'error' | 'titled';

export const TITLING_OUTCOME_TEXT: Record<TitlingOutcome, string> = {
  titled: 'Summary updated',
  already: 'A summary is already being written — try again in a moment',
  budget: 'This project has hit its hourly limit for summaries — try again later',
  no_material: 'Nothing typed in this session to summarize yet',
  no_provider: 'No provider is configured for summaries — set one in Settings',
  no_credential: 'The provider has no credential — add one in Settings',
  local_provider: 'The local provider has no endpoint — set one in Settings',
  no_endpoint: 'The provider has no endpoint — set one in Settings',
  no_model: 'The provider has no model — set one in Settings',
  malformed: 'The provider answered with something that was not a summary',
  provider: 'The provider refused the request',
  unreachable: 'The provider could not be reached',
  superseded: 'A summary landed from elsewhere first',
  error: 'Something went wrong writing the summary',
};

/** Asks the server to title the session now; on an answer, the session's facts are read again. */
export function useTitleSession(projectId: string, sessionId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => postJson<{ outcome: TitlingOutcome }>(`${project(projectId)}/sessions/${seg(sessionId)}/title`),
    onSuccess: () => Promise.all([
      client.invalidateQueries({ queryKey: ['session', projectId, sessionId] }),
      client.invalidateQueries({ queryKey: ['sessions', projectId] }),
    ]),
  });
}

export function useSession(projectId: string, sessionId: string) {
  return useQuery({ queryKey: ['session', projectId, sessionId], queryFn: ({ signal }) => fetchJson<SessionResponse>(`${project(projectId)}/sessions/${seg(sessionId)}`, signal) });
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

export function useActivity(projectId: string) {
  return useQuery({ queryKey: ['activity', projectId], queryFn: ({ signal }) => fetchJson<{ items: FeedItem[]; stats: ProjectStats }>(`${project(projectId)}/activity`, signal) });
}

/** The text of a blob, read as text whatever it happens to contain. Blobs are content-addressed and immutable, so a fetched one is never refetched. */
export function useBlobText(projectId: string, key: string) {
  return useQuery({
    queryKey: ['blob-text', projectId, key],
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const res = await fetch(blobUrl(projectId, key), { credentials: 'same-origin', signal });
      if (res.status === 401) throw new SignedOutError();
      if (!res.ok) throw new ApiError(res.status, null);
      return res.text();
    },
  });
}
