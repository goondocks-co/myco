/**
 * Plan files as the member captures them: a write tool landing inside a
 * runtime's plan directory is the plan itself. A post-tool-use hook reads the
 * file at once and ships it keyed by its path; for an agent whose hooks do not
 * see tool calls, the turn-end hook finds the writes in the transcript delta
 * and reads the files then — an `Edit` record carries only a diff, never the
 * file. Either way Stop re-reads every tracked path and sends
 * what changed since.
 */
import fs from 'node:fs';
import path from 'node:path';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { resolveHomeDir } from '../paths/home.js';
import { resolveWorktreeRoot } from '../project-root.js';
import { remainingMs, type HookBudget } from './budget.js';
import { recordSessionLoss } from './capture-loss.js';
import { resolveMemberProjectRoot } from './credential.js';
import { planEvent, planKeyForPath, type EnvelopeContext, type OutboundEvent } from './envelope.js';
import type { SessionState } from './session-state.js';
import { firstHeading, sha256Text } from './text.js';

/** The tools that write a file, as each runtime names them. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Create', 'write', 'edit', 'patch', 'create']);
/** The extensions a plan file carries. */
export const PLAN_FILE_EXTENSIONS: readonly string[] = ['.md'];
/** The largest plan file read into an event; a larger one is left alone. */
export const MAX_PLAN_FILE_BYTES = 1_048_576;

/** The root a hook's plan paths resolve against: the git worktree the call ran in, so a worktree's own `.claude/plans/` counts; else the credential's root; else the worktree-aware root of the cwd. */
export function planRootFor(credentialRoot: string | undefined, cwd: string | undefined): string {
  return resolveWorktreeRoot(cwd) ?? credentialRoot ?? resolveMemberProjectRoot(cwd);
}

/** A plan directory as the manifest names it, resolved: `~/` against home, a relative one against the project root. */
export function resolvePlanDir(dir: string, projectRoot: string): string {
  const expanded = dir.startsWith('~/') ? path.join(resolveHomeDir(), dir.slice(2)) : dir;
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

/** True when the file sits inside one of the directories — on a directory boundary, never a sibling with the same prefix. */
export function isInPlanDirectory(filePath: string, dirs: readonly string[], projectRoot: string): boolean {
  const abs = path.resolve(projectRoot, filePath);
  return dirs.some((dir) => {
    const absDir = resolvePlanDir(dir, projectRoot);
    const prefix = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
    return abs === absDir || abs.startsWith(prefix);
  });
}

/**
 * The absolute path of the plan file a tool call wrote, or null when the call is not a write of a plan file into the
 * runtime's plan directories: the ones the agent's manifest names, and the extra ones this machine's settings name
 * (`machine-settings.ts`), each `~/`, absolute or relative to the project root.
 */
export function planWritePath(agent: string, toolName: string | undefined, toolInput: unknown, projectRoot: string, machineDirs: readonly string[] = []): string | null {
  if (typeof toolName !== 'string' || !FILE_WRITE_TOOLS.has(toolName)) return null;
  const input = (toolInput !== null && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const filePath = input.file_path ?? input.path ?? input.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const dirs = [...(HOOK_CONFIG[agent]?.planDirs ?? []), ...machineDirs];
  if (dirs.length === 0) return null;
  if (!PLAN_FILE_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) return null;
  if (!isInPlanDirectory(filePath, dirs, projectRoot)) return null;
  return path.resolve(projectRoot, filePath);
}

/** The path a plan is keyed by: project-relative inside the root, `~/`-prefixed under home, else absolute; forward slashes throughout. The Deployment's tool takes the same form. */
export function normalizePlanPath(projectRoot: string, absPath: string): string {
  const root = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  const home = resolveHomeDir();
  const out = absPath.startsWith(root)
    ? absPath.slice(root.length)
    : absPath.startsWith(home + path.sep) ? `~/${absPath.slice(home.length + 1)}` : absPath;
  return out.split(path.sep).join('/');
}

/** The file a keyed path names. */
export const planFilePath = (projectRoot: string, normalized: string): string => resolvePlanDir(normalized, projectRoot);

/** Why a plan file yielded no text. */
export type PlanFileMiss = 'absent' | 'unreadable' | 'not-file' | 'oversize';

/** The file's text, or the filesystem disposition or size bound that prevented its read. */
export function readPlanFileOrMiss(absPath: string): { content: string } | { miss: PlanFileMiss; bytes?: number } {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile()) return { miss: 'not-file' };
    if (stat.size > MAX_PLAN_FILE_BYTES) return { miss: 'oversize', bytes: stat.size };
    return { content: fs.readFileSync(absPath, 'utf-8') };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { miss: code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable' };
  }
}

/** The file's text, or null when it is absent, unreadable, not a file, or larger than the bound. */
export function readPlanFile(absPath: string): string | null {
  const read = readPlanFileOrMiss(absPath);
  return 'content' in read ? read.content : null;
}

/** The receipt recorded for a plan file too large to ship, keyed by the size that was refused so a smaller rewrite ships. */
const oversizeReceipt = (bytes: number): string => `oversize:${bytes}`;
/** A tracked path with no captured content yet. */
const UNCAPTURED_PLAN_HASH = '';
/** A missing path gets time for the writer to publish it before the read obligation expires. */
export const PENDING_PLAN_READ_TTL_MS = 5 * 60_000;
/** Outstanding plan reads are bounded even if a harness reports an unlimited stream of deleted paths. */
export const MAX_PENDING_PLAN_READS = 1_000;

function recordLostPlan(state: SessionState, normalized: string, at: number): void {
  const pending = state.planPaths[normalized];
  if (pending?.pendingRead === undefined) return;
  recordSessionLoss(state, `plan:${pending.planKey}:${pending.pendingSince ?? 0}`, 'plan', at);
  delete state.planPaths[normalized];
  process.stderr.write(`[myco] plan file ${normalized} remained unavailable — capture lost\n`);
}

function boundPendingPlanReads(state: SessionState, at: number): void {
  const pending = Object.entries(state.planPaths)
    .filter(([, entry]) => entry.pendingRead !== undefined)
    .sort((left, right) => (left[1].pendingSince ?? 0) - (right[1].pendingSince ?? 0));
  for (const [normalized] of pending.slice(0, Math.max(0, pending.length - MAX_PENDING_PLAN_READS))) {
    recordLostPlan(state, normalized, at);
  }
}

/** The plan's title: its first heading, else the file's name. */
export const planTitle = (content: string, filePath: string): string => firstHeading(content) ?? path.basename(filePath, path.extname(filePath));

export interface PlanFileCapture {
  events: OutboundEvent[];
  /** The receipts for `events`; applied with the append. */
  record: (state: SessionState) => void;
}

/**
 * The plan event for a file just written, or none when this path last shipped
 * the same content. `promptId` names the turn on the file's first capture
 * only — a plan belongs to the turn that produced it — and is passed by a
 * caller whose hooks mint the turn's id; an agent whose turns the Deployment
 * parses has no id the member could name.
 */
export function planFileCapture(ctx: EnvelopeContext, state: SessionState, projectId: string, projectRoot: string, absPath: string, promptId?: string): PlanFileCapture {
  const normalized = normalizePlanPath(projectRoot, absPath);
  return capturePlanPath(ctx, state, projectRoot, absPath, state.planPaths[normalized]?.planKey ?? planKeyForPath(projectId, normalized), promptId);
}

/** File reads and their retry obligations share one receipt path across write discovery and the backstop. */
function capturePlanPath(ctx: EnvelopeContext, state: SessionState, projectRoot: string, absPath: string, planKey: string, promptId?: string, now: () => number = Date.now): PlanFileCapture {
  const none: PlanFileCapture = { events: [], record: () => {} };
  const normalized = normalizePlanPath(projectRoot, absPath);
  const shipped = state.planPaths[normalized];
  const read = readPlanFileOrMiss(absPath);
  if ('miss' in read) {
    if (read.miss !== 'oversize') {
      const miss = read.miss;
      const observedAt = now();
      const sameMiss = shipped?.pendingRead === miss && shipped.pendingSince !== undefined;
      const pendingSince = sameMiss ? shipped.pendingSince! : observedAt;
      const pendingChecks = sameMiss ? (shipped.pendingChecks ?? 0) + 1 : 1;
      const expired = miss !== 'unreadable' && pendingChecks >= 2 && observedAt - pendingSince >= PENDING_PLAN_READ_TTL_MS;
      if (expired) return { events: [], record: (next) => {
        const current = next.planPaths[normalized];
        if (current?.pendingRead === miss && current.pendingSince === shipped?.pendingSince) recordLostPlan(next, normalized, observedAt);
      } };
      if (shipped?.pendingRead !== read.miss) process.stderr.write(`[myco] plan file ${normalized} is ${read.miss} — read pending\n`);
      return { events: [], record: (next) => {
        const current = next.planPaths[normalized];
        if (current !== undefined && (current.hash !== shipped?.hash || current.pendingRead !== shipped?.pendingRead)) return;
        next.planPaths[normalized] = { ...current, planKey: current?.planKey ?? planKey, hash: current?.hash ?? UNCAPTURED_PLAN_HASH, pendingRead: miss, pendingSince, pendingChecks,
          ...(current?.hash === undefined && promptId !== undefined ? { promptId } : {}) };
        if (current?.pendingRead === undefined) boundPendingPlanReads(next, observedAt);
      } };
    }
    const receipt = oversizeReceipt(read.bytes ?? 0);
    if (shipped?.hash === receipt) return none;
    process.stderr.write(`[myco] plan file ${normalized} is ${read.bytes} bytes, over the ${MAX_PLAN_FILE_BYTES}-byte bound — not captured until it shrinks\n`);
    return { events: [], record: (next) => { next.planPaths[normalized] = { planKey, hash: receipt }; } };
  }
  const content = read.content;
  const hash = sha256Text(content);
  if (shipped?.hash === hash) return shipped.pendingRead === undefined ? none : {
    events: [], record: (next) => {
      const current = next.planPaths[normalized];
      if (current?.hash === hash) {
        delete current.pendingRead;
        delete current.pendingSince;
        delete current.pendingChecks;
      }
    },
  };
  const event = planEvent(ctx, { planKey, content, title: planTitle(content, absPath), originPath: normalized, promptId: shipped === undefined || shipped.hash === UNCAPTURED_PLAN_HASH ? shipped?.promptId ?? promptId : undefined });
  if (event.blobSource !== undefined) event.blobSource.recovery = { path: absPath };
  return {
    events: [event],
    record: (next) => { next.planPaths[normalized] = { planKey, hash }; },
  };
}

/** A tool call as a transcript line records it: the tool's name and its arguments. */
interface RecordedToolCall {
  name: string;
  input: unknown;
}

/** The arguments of a call a runtime serialized as a JSON string (Codex), or the value as it stands. */
function callArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw) as unknown; } catch { return { arguments: raw }; }
}

/**
 * The tool calls one transcript line records, in the three shapes the
 * transcripts the member ships carry them in: Claude Code's `tool_use` blocks
 * inside an assistant message, Codex's `function_call` response items, and the
 * `tool` line Myco's own plugins write.
 */
export function toolCallsInLine(line: Record<string, unknown>): RecordedToolCall[] {
  const calls: RecordedToolCall[] = [];
  const message = line.message;
  const content = message && typeof message === 'object' ? (message as Record<string, unknown>).content : undefined;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use' && typeof b.name === 'string') calls.push({ name: b.name, input: b.input });
    }
  }
  const payload = line.payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (p.type === 'function_call' && typeof p.name === 'string') calls.push({ name: p.name, input: callArguments(p.arguments) });
  }
  if (line.type === 'tool' && typeof line.name === 'string') calls.push({ name: line.name, input: line.input });
  return calls;
}

/** The plan files the given transcript lines record a write into, each once, in first-write order. */
export function planWritesInLines(agent: string, lines: ReadonlyArray<Record<string, unknown>>, projectRoot: string, machineDirs: readonly string[] = []): string[] {
  const paths: string[] = [];
  for (const line of lines) {
    for (const call of toolCallsInLine(line)) {
      const written = planWritePath(agent, call.name, call.input, projectRoot, machineDirs);
      if (written !== null && !paths.includes(written)) paths.push(written);
    }
  }
  return paths;
}

/** The plan events for every plan file the lines record a write into, read now from disk; one event per file whose content differs from what last shipped. */
export function planFilesWritten(ctx: EnvelopeContext, state: SessionState, projectId: string, projectRoot: string, absPaths: readonly string[]): PlanFileCapture & { captured: string[] } {
  const events: OutboundEvent[] = [];
  const records: Array<(state: SessionState) => void> = [];
  const captured: string[] = [];
  for (const absPath of absPaths) {
    const capture = planFileCapture(ctx, state, projectId, projectRoot, absPath);
    records.push(capture.record);
    captured.push(normalizePlanPath(projectRoot, absPath));
    events.push(...capture.events);
  }
  return { events, captured, record: (next) => { for (const record of records) record(next); } };
}

/** Every tracked plan, including unresolved first reads, re-read inside the hook's budget. Changed content ships under its key. Paths in `skip` were read by the same hook already. */
export function planBackstop(ctx: EnvelopeContext, state: SessionState, projectRoot: string, budget?: HookBudget, now: () => number = Date.now, skip: readonly string[] = []): PlanFileCapture {
  const events: OutboundEvent[] = [];
  const records: PlanFileCapture['record'][] = [(next) => { boundPendingPlanReads(next, now()); }];
  for (const [normalized, shipped] of Object.entries(state.planPaths)) {
    if (skip.includes(normalized)) continue;
    if (budget !== undefined && remainingMs(budget, now()) < budget.requestTimeoutMs) break;
    const capture = capturePlanPath(ctx, state, projectRoot, planFilePath(projectRoot, normalized), shipped.planKey, shipped.promptId, now);
    events.push(...capture.events);
    records.push(capture.record);
  }
  return { events, record: (next) => { for (const record of records) record(next); } };
}
