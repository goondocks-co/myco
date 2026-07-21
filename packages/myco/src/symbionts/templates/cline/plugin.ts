// Managed by Myco. Regenerated on `myco update`. Edit src/symbionts/templates/cline/plugin.ts in the Myco repo instead.
// myco:plugin-marker:cline
//
// Myco Codebase Intelligence Plugin for Cline.
//
// This plugin runs inside Cline's SDK plugin runtime and communicates with the
// local Myco daemon over HTTP. It has no external runtime imports so Cline keeps
// working in projects where Myco is absent or the daemon is down.

import { readFileSync, appendFileSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const TOOL_OUTPUT_PREVIEW_CHARS = 200;
const MYCO_FETCH_TIMEOUT_MS = 3000;
const RESUME_CONTEXT_MAX_CHARS = 4000;
const MYCO_AUTH_HEADER = "x-myco-auth";
const MYCO_METADATA_MARKER = "myco";
const COMPACTION_HEADING = "## Myco - Project Context\n\n";

const REQUEST_CONTEXT_HEADERS = {
  projectRoot: "x-myco-project-root",
  projectId: "x-myco-project-id",
  sessionId: "x-myco-session-id",
} as const;

const BATCH_KIND = {
  INITIAL: "initial",
  STEERING: "steering",
} as const;

type BatchKind = typeof BATCH_KIND[keyof typeof BATCH_KIND];
type AnyRecord = Record<string, unknown>;

let setupWorkspaceRoot: string | undefined;
let setupSessionId: string | undefined;
let setupBranch: string | undefined;
let cachedDaemonPort: { statePath: string; port: number | null } | undefined;
const activeSessions = new Set<string>();
const injectedSessions = new Set<string>();
const seenPromptKeys = new Set<string>();
const currentParentBatchBySession = new Map<string, number>();
const lastAssistantMessageBySession = new Map<string, string>();

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null;
}

function pickString(record: unknown, keys: readonly string[]): string | undefined {
  if (!isRecord(record)) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

const RUNTIME_PIN_INSECURE_MODE_MASK = 0o022;

/**
 * Read a `runtime.home` pin only when it passes the same G7 trust check the
 * CLI shim uses (`checkRuntimeCommandTrust` in bin/runtime-redirect.cjs): a
 * group/other-writable or foreign-owned pin is refused so a hostile local user
 * can't redirect capture to a daemon they control. Returns the trimmed value
 * (an absolute home path) or null.
 */
function readTrustedPin(filePath: string): string | null {
  try {
    if (process.platform !== "win32") {
      const stat = statSync(filePath);
      const myUid = typeof process.getuid === "function" ? process.getuid() : null;
      if (myUid !== null && stat.uid !== myUid) return null;
      if ((stat.mode & 0o777) & RUNTIME_PIN_INSECURE_MODE_MASK) return null;
    }
    const raw = readFileSync(filePath, "utf-8").trim();
    return raw || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the `runtime.home` pin for a project: walk up from `directory` for a
 * project pin (`<dir>/.myco/runtime.home`), then the machine pin
 * (`~/.myco/runtime.home`). Mirrors the layered resolution in
 * bin/runtime-redirect.cjs. Returns the absolute home path or null.
 */
function readRuntimeHomePin(directory: string): string | null {
  let dir = resolve(directory);
  while (true) {
    const pin = readTrustedPin(join(dir, ".myco", "runtime.home"));
    if (pin) return expandTilde(pin);
    const parent = join(dir, "..");
    if (resolve(parent) === dir) break;
    dir = resolve(parent);
  }
  const machine = readTrustedPin(join(homedir(), ".myco", "runtime.home"));
  return machine ? expandTilde(machine) : null;
}

function expandTilde(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

/**
 * Resolve this project's Myco home — the daemon it routes to. A trusted
 * `runtime.home` pin wins so a dogfood project pinned to `~/.myco-dev` reads
 * `~/.myco-dev/service/daemon.json` instead of the prod `~/.myco`. Falls back
 * to `MYCO_HOME`, then the machine `~/.myco`.
 */
function resolveMycoHome(directory?: string): string {
  if (directory) {
    const pinned = readRuntimeHomePin(directory);
    if (pinned) return pinned;
  }
  const configured = process.env.MYCO_HOME?.trim();
  if (!configured) return join(homedir(), ".myco");
  return expandTilde(configured);
}

function readTomlString(raw: string, section: string, key: string): string | null {
  let currentSection: string | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      currentSection = header[1]!;
      continue;
    }
    if (currentSection !== section) continue;
    const match = /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']*)["']/.exec(trimmed);
    if (match?.[1] === key) return match[2]!;
  }
  return null;
}

function projectUsesGrove(directory: string): boolean {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    return /\[grove\][^\[]*\bid\s*=/.test(raw);
  } catch {
    return false;
  }
}

function readProjectAndGroveIds(directory: string): { projectId: string; groveId: string } | null {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    const projectId = readTomlString(raw, "project", "id");
    const groveId = readTomlString(raw, "grove", "id");
    if (!projectId || !groveId) return null;
    return { projectId, groveId };
  } catch {
    return null;
  }
}

function buildRequestContextHeaders(directory: string, sessionId?: string): Record<string, string> {
  try {
    const raw = readFileSync(join(directory, ".myco", "project.toml"), "utf-8");
    const projectId = readTomlString(raw, "project", "id");
    if (!projectId) return {};
    return {
      [REQUEST_CONTEXT_HEADERS.projectRoot]: resolve(directory),
      [REQUEST_CONTEXT_HEADERS.projectId]: projectId,
      ...(sessionId ? { [REQUEST_CONTEXT_HEADERS.sessionId]: sessionId } : {}),
    };
  } catch {
    return {};
  }
}

function resolveDaemonStatePath(directory: string): string {
  if (!projectUsesGrove(directory)) return join(directory, ".myco", "daemon.json");
  // One daemon per home: the HOME is the discriminator, the daemon always
  // lives under `service/`. A dev-pinned project resolves a dev home via the
  // `runtime.home` pin and reads that daemon instead of prod.
  return join(resolveMycoHome(directory), "service", "daemon.json");
}

function readDaemonState(directory: string): { port: number | null; authToken: string | null } {
  try {
    const raw = readFileSync(resolveDaemonStatePath(directory), "utf-8");
    const info = JSON.parse(raw) as { port?: unknown; auth_token?: unknown };
    return {
      port: typeof info.port === "number" ? info.port : null,
      authToken: typeof info.auth_token === "string" && info.auth_token.length > 0 ? info.auth_token : null,
    };
  } catch {
    return { port: null, authToken: null };
  }
}

function getDaemonPort(directory: string): number | null {
  const statePath = resolveDaemonStatePath(directory);
  if (!cachedDaemonPort || cachedDaemonPort.statePath !== statePath) {
    cachedDaemonPort = { statePath, port: readDaemonState(directory).port };
  }
  return cachedDaemonPort.port;
}

function refreshDaemonPort(directory: string): number | null {
  const statePath = resolveDaemonStatePath(directory);
  cachedDaemonPort = { statePath, port: readDaemonState(directory).port };
  return cachedDaemonPort.port;
}

function withRequestContextHeaders(directory: string, sessionId: string | undefined, init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers);
  const ctxHeaders = buildRequestContextHeaders(directory, sessionId);
  let hasContextSwitchingHeader = false;
  for (const [key, value] of Object.entries(ctxHeaders)) {
    if (!headers.has(key)) headers.set(key, value);
    if (key === REQUEST_CONTEXT_HEADERS.projectId) hasContextSwitchingHeader = true;
  }
  if (hasContextSwitchingHeader && !headers.has(MYCO_AUTH_HEADER)) {
    const token = readDaemonState(directory).authToken;
    if (token) headers.set(MYCO_AUTH_HEADER, token);
  }
  return { ...init, headers };
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MYCO_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res.ok ? res : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromDaemon(
  directory: string,
  urlPath: string,
  sessionId: string | undefined,
  init?: RequestInit,
): Promise<Response | null> {
  const port = getDaemonPort(directory);
  if (!port) return null;
  const requestInit = withRequestContextHeaders(directory, sessionId, init);
  const first = await fetchWithTimeout(`http://localhost:${port}${urlPath}`, requestInit);
  if (first) return first;
  const freshPort = refreshDaemonPort(directory);
  if (!freshPort || freshPort === port) return null;
  return fetchWithTimeout(`http://localhost:${freshPort}${urlPath}`, requestInit);
}

async function postJson(
  directory: string,
  urlPath: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ ok: boolean; data?: unknown }> {
  const res = await fetchFromDaemon(directory, urlPath, sessionId, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res) return { ok: false };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: true };
  }
}

function resolveBufferDir(directory: string): string | null {
  const ids = readProjectAndGroveIds(directory);
  if (!ids) return null;
  return join(resolveMycoHome(directory), "groves", ids.groveId, "projects", ids.projectId, "buffer");
}

function bufferEvent(directory: string, sessionId: string, event: Record<string, unknown>): void {
  try {
    const bufferDir = resolveBufferDir(directory);
    if (!bufferDir) return;
    mkdirSync(bufferDir, { recursive: true });
    const { session_id: _sid, ...payload } = event;
    appendFileSync(join(bufferDir, `${sessionId}.jsonl`), JSON.stringify({
      ...payload,
      timestamp: payload.timestamp ?? new Date().toISOString(),
    }) + "\n");
  } catch {
    // Best-effort: never break Cline.
  }
}

function isIgnoredResponse(data: unknown): boolean {
  return isRecord(data) && typeof data.ignored === "string" && data.ignored.length > 0;
}

export function shouldBufferPluginFallback(result: { ok: boolean; data?: unknown }, eventType: string | undefined): boolean {
  if (!result.ok) return true;
  const data = result.data;
  if (isIgnoredResponse(data)) return false;
  const persisted = isRecord(data) ? data.persisted : undefined;
  if (typeof persisted === "boolean") {
    if (persisted) return false;
    return isRecord(data) && data.buffered !== true;
  }
  return eventType === "stop";
}

async function postEventWithBuffer(
  directory: string,
  sessionId: string,
  event: Record<string, unknown>,
): Promise<unknown> {
  const result = await postJson(directory, "/events", event, sessionId);
  const eventType = typeof event.type === "string" ? event.type : undefined;
  if (shouldBufferPluginFallback(result, eventType)) {
    bufferEvent(directory, sessionId, event);
    return undefined;
  }
  return result.data;
}

function detectGitBranch(directory: string): string | undefined {
  if (setupBranch) return setupBranch;
  try {
    const out = execFileSync("git", ["-C", directory, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf-8",
      timeout: 1000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return out && out !== "HEAD" ? out : undefined;
  } catch {
    return undefined;
  }
}

function snapshotFromContext(context: unknown): AnyRecord | undefined {
  if (!isRecord(context)) return undefined;
  return isRecord(context.snapshot) ? context.snapshot : undefined;
}

export function extractSessionId(context: unknown): string | undefined {
  const snapshot = snapshotFromContext(context);
  return pickString(snapshot, ["conversationId", "runId", "agentId"])
    ?? pickString(context, ["sessionId", "conversationId", "runId", "agentId"])
    ?? setupSessionId;
}

export function extractWorkspaceRoot(context: unknown): string {
  const workspaceRoot = setupWorkspaceRoot
    ?? pickString(context, ["cwd", "directory", "workspaceRoot"])
    ?? pickString(snapshotFromContext(context), ["workspaceRoot"]);
  return workspaceRoot ? resolve(workspaceRoot) : process.cwd();
}

function extractParentSessionId(context: unknown): string | undefined {
  const snapshot = snapshotFromContext(context);
  return pickString(snapshot, ["parentAgentId"]) ?? pickString(context, ["parentAgentId"]);
}

function textFromMessageContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is AnyRecord => isRecord(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n")
    .trim();
}

function isMycoSyntheticMessage(message: unknown): boolean {
  if (!isRecord(message)) return false;
  const metadata = message.metadata;
  return isRecord(metadata) && metadata[MYCO_METADATA_MARKER] === true;
}

export function extractLatestUserPrompt(context: unknown): { key: string; text: string } | null {
  const snapshot = snapshotFromContext(context);
  const request = isRecord(context) && isRecord(context.request) ? context.request : undefined;
  const messages = Array.isArray(request?.messages)
    ? request.messages
    : Array.isArray(snapshot?.messages)
      ? snapshot.messages
      : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!isRecord(message) || message.role !== "user" || isMycoSyntheticMessage(message)) continue;
    const text = textFromMessageContent(message.content);
    if (!text) continue;
    const id = typeof message.id === "string" && message.id.length > 0 ? message.id : String(i);
    return { key: id, text };
  }
  return null;
}

function collectAssistantText(message: unknown): string {
  if (!isRecord(message)) return "";
  return textFromMessageContent(message.content);
}

export function summarizeToolOutput(output: unknown): string {
  const text = typeof output === "string"
    ? output
    : output == null
      ? ""
      : JSON.stringify(output);
  return text.length > TOOL_OUTPUT_PREVIEW_CHARS ? text.slice(0, TOOL_OUTPUT_PREVIEW_CHARS) + "..." : text;
}

function toolNameFromContext(context: unknown): string {
  if (!isRecord(context)) return "unknown";
  const toolCall = isRecord(context.toolCall) ? context.toolCall : undefined;
  const tool = isRecord(context.tool) ? context.tool : undefined;
  return pickString(toolCall, ["toolName", "name"]) ?? pickString(tool, ["name"]) ?? "unknown";
}

function toolInputFromContext(context: unknown): unknown {
  if (!isRecord(context)) return {};
  return context.input ?? (isRecord(context.toolCall) ? context.toolCall.input : undefined) ?? {};
}

async function mycoRegisterSession(directory: string, sessionId: string, parentSessionId: string | undefined): Promise<void> {
  if (activeSessions.has(sessionId)) return;
  activeSessions.add(sessionId);
  await postJson(directory, "/sessions/register", {
    session_id: sessionId,
    agent: "cline",
    parent_session_id: parentSessionId,
    branch: detectGitBranch(directory),
    started_at: new Date().toISOString(),
  }, sessionId);
}

async function mycoUnregisterSession(directory: string, sessionId: string): Promise<void> {
  activeSessions.delete(sessionId);
  await postJson(directory, "/sessions/unregister", { session_id: sessionId }, sessionId);
}

async function mycoPostUserPrompt(directory: string, sessionId: string, prompt: string): Promise<{ batchId?: string }> {
  const parentBatch = currentParentBatchBySession.get(sessionId);
  const kind: BatchKind = parentBatch == null ? BATCH_KIND.INITIAL : BATCH_KIND.STEERING;
  const result = await postEventWithBuffer(directory, sessionId, {
    type: "user_prompt",
    session_id: sessionId,
    agent: "cline",
    prompt,
    kind,
    parent_prompt_batch_id: kind === BATCH_KIND.INITIAL ? null : parentBatch,
  });
  const batchId = isRecord(result) && typeof result.batchId === "string" ? result.batchId : undefined;
  if (kind === BATCH_KIND.INITIAL && batchId != null) currentParentBatchBySession.set(sessionId, batchId);
  return { batchId };
}

async function mycoPostToolUse(directory: string, sessionId: string, toolName: string, toolInput: unknown, toolOutput: unknown): Promise<void> {
  await postEventWithBuffer(directory, sessionId, {
    type: "tool_use",
    session_id: sessionId,
    agent: "cline",
    tool_name: toolName,
    tool_input: toolInput,
    output_preview: summarizeToolOutput(toolOutput),
  });
}

async function mycoPostStop(directory: string, sessionId: string, lastAssistantMessage: string | undefined): Promise<void> {
  const payload = {
    type: "stop" as const,
    session_id: sessionId,
    agent: "cline",
    last_assistant_message: lastAssistantMessage,
  };
  bufferEvent(directory, sessionId, payload);
  await postJson(directory, "/events/stop", payload, sessionId);
}

async function fetchMycoSessionContext(directory: string, sessionId: string): Promise<string | null> {
  const result = await postJson(directory, "/context", { session_id: sessionId }, sessionId);
  if (!result.ok) return null;
  const text = isRecord(result.data) && typeof result.data.text === "string" ? result.data.text.trim() : "";
  return text ? text : null;
}

async function fetchMycoResumeContext(directory: string, sessionId: string, parentSessionId: string): Promise<string | null> {
  const result = await postJson(directory, "/context/resume", {
    session_id: sessionId,
    parent_session_id: parentSessionId,
  }, sessionId);
  if (!result.ok) return null;
  const text = isRecord(result.data) && typeof result.data.text === "string" ? result.data.text.trim() : "";
  return text && text.length <= RESUME_CONTEXT_MAX_CHARS ? text : null;
}

async function fetchPerPromptContext(
  directory: string,
  sessionId: string,
  prompt: string,
  batchId: string | undefined,
): Promise<string | null> {
  const result = await postJson(directory, "/context/prompt", {
    session_id: sessionId,
    prompt,
    parent_prompt_batch_id: batchId,
  }, sessionId);
  if (!result.ok) return null;
  const text = isRecord(result.data) && typeof result.data.additionalContext === "string"
    ? result.data.additionalContext.trim()
    : "";
  return text ? text : null;
}

function makeSyntheticUserMessage(text: string): AnyRecord {
  return {
    id: `myco-${Date.now()}`,
    role: "user",
    content: [{ type: "text", text }],
    createdAt: Date.now(),
    metadata: { [MYCO_METADATA_MARKER]: true },
  };
}

async function maybeInjectContext(context: unknown, directory: string, sessionId: string, prompt: string, batchId?: string): Promise<AnyRecord | undefined> {
  const request = isRecord(context) && isRecord(context.request) ? context.request : undefined;
  if (!request || !Array.isArray(request.messages)) return undefined;
  const additions: string[] = [];

  if (!injectedSessions.has(sessionId)) {
    injectedSessions.add(sessionId);
    const parentSessionId = extractParentSessionId(context);
    const sessionContext = parentSessionId
      ? await fetchMycoResumeContext(directory, sessionId, parentSessionId)
      : await fetchMycoSessionContext(directory, sessionId);
    if (sessionContext) additions.push(sessionContext);
  }

  const perPromptContext = await fetchPerPromptContext(directory, sessionId, prompt, batchId);
  if (perPromptContext) additions.push(perPromptContext);
  if (additions.length === 0) return undefined;

  return {
    messages: [
      ...request.messages,
      makeSyntheticUserMessage(COMPACTION_HEADING + additions.join("\n\n")),
    ],
  };
}

async function handleBeforeModel(context: unknown): Promise<AnyRecord | undefined> {
  const sessionId = extractSessionId(context);
  if (!sessionId) return undefined;
  const directory = extractWorkspaceRoot(context);
  await mycoRegisterSession(directory, sessionId, extractParentSessionId(context));

  const prompt = extractLatestUserPrompt(context);
  if (!prompt) return undefined;
  const promptKey = `${sessionId}:${prompt.key}`;
  if (seenPromptKeys.has(promptKey)) return undefined;
  seenPromptKeys.add(promptKey);

  const { batchId } = await mycoPostUserPrompt(directory, sessionId, prompt.text);
  return maybeInjectContext(context, directory, sessionId, prompt.text, batchId);
}

async function handleAfterModel(context: unknown): Promise<void> {
  const sessionId = extractSessionId(context);
  if (!sessionId || !isRecord(context)) return;
  const text = collectAssistantText(context.assistantMessage);
  if (text) lastAssistantMessageBySession.set(sessionId, text);
}

async function handleAfterTool(context: unknown): Promise<void> {
  const sessionId = extractSessionId(context);
  if (!sessionId || !isRecord(context)) return;
  const directory = extractWorkspaceRoot(context);
  await mycoPostToolUse(
    directory,
    sessionId,
    toolNameFromContext(context),
    toolInputFromContext(context),
    isRecord(context.result) ? context.result.output : context.result,
  );
}

async function handleAfterRun(context: unknown): Promise<void> {
  const sessionId = extractSessionId(context);
  if (!sessionId) return;
  const directory = extractWorkspaceRoot(context);
  await mycoPostStop(directory, sessionId, lastAssistantMessageBySession.get(sessionId));
  await mycoUnregisterSession(directory, sessionId);
}

async function handleEvent(event: unknown): Promise<void> {
  if (!isRecord(event)) return;
  if (event.type === "run-started") {
    const snapshot = isRecord(event.snapshot) ? event.snapshot : undefined;
    const sessionId = pickString(snapshot, ["conversationId", "runId", "agentId"]);
    if (sessionId) await mycoRegisterSession(extractWorkspaceRoot({ snapshot }), sessionId, pickString(snapshot, ["parentAgentId"]));
  }
}

export const MycoClinePlugin = {
  name: "myco",
  manifest: {
    capabilities: ["hooks"],
  },
  setup: (_api: unknown, ctx: unknown) => {
    if (!isRecord(ctx)) return;
    setupSessionId = isRecord(ctx.session) ? pickString(ctx.session, ["sessionId"]) : undefined;
    if (isRecord(ctx.workspaceInfo)) {
      setupWorkspaceRoot = pickString(ctx.workspaceInfo, ["rootPath"]);
      setupBranch = pickString(ctx.workspaceInfo, ["latestGitBranchName"]);
    }
  },
  hooks: {
    beforeModel: handleBeforeModel,
    afterModel: handleAfterModel,
    afterTool: handleAfterTool,
    afterRun: handleAfterRun,
    onEvent: handleEvent,
  },
};

export default MycoClinePlugin;
