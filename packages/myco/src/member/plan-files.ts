/**
 * Plan files as the member captures them: a write tool landing inside a
 * runtime's plan directory is the plan itself. The hook reads the file at once
 * and ships it keyed by its path, named after the prompt that wrote it; Stop
 * re-reads every path the session has shipped and sends what changed since.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { planEvent, planKeyForPath, type EnvelopeContext, type OutboundEvent } from './envelope.js';
import type { SessionState } from './session-state.js';
import { firstHeading, sha256Text } from './text.js';

/** The tools that write a file, as each runtime names them. */
const FILE_WRITE_TOOLS = new Set(['Write', 'Edit', 'Create', 'write', 'edit', 'patch', 'create']);
/** The extensions a plan file carries. */
export const PLAN_FILE_EXTENSIONS: readonly string[] = ['.md'];
/** The largest plan file read into an event; a larger one is left alone. */
export const MAX_PLAN_FILE_BYTES = 1_048_576;

/** A plan directory as the manifest names it, resolved: `~/` against home, a relative one against the project root. */
export function resolvePlanDir(dir: string, projectRoot: string): string {
  const expanded = dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(2)) : dir;
  return path.isAbsolute(expanded) ? expanded : path.resolve(projectRoot, expanded);
}

/** True when the file sits inside one of the directories — on a directory boundary, never a sibling with the same prefix. */
export function isInPlanDirectory(filePath: string, dirs: readonly string[], projectRoot: string): boolean {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
  return dirs.some((dir) => {
    const absDir = resolvePlanDir(dir, projectRoot);
    const prefix = absDir.endsWith(path.sep) ? absDir : absDir + path.sep;
    return abs === absDir || abs.startsWith(prefix);
  });
}

/** The absolute path of the plan file a tool call wrote, or null when the call is not a write of a plan file into the runtime's plan directories. */
export function planWritePath(agent: string, toolName: string | undefined, toolInput: unknown, projectRoot: string): string | null {
  if (typeof toolName !== 'string' || !FILE_WRITE_TOOLS.has(toolName)) return null;
  const input = (toolInput !== null && typeof toolInput === 'object' ? toolInput : {}) as Record<string, unknown>;
  const filePath = input.file_path ?? input.path ?? input.filePath;
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  const dirs = HOOK_CONFIG[agent]?.planDirs ?? [];
  if (dirs.length === 0) return null;
  if (!PLAN_FILE_EXTENSIONS.includes(path.extname(filePath).toLowerCase())) return null;
  if (!isInPlanDirectory(filePath, dirs, projectRoot)) return null;
  return path.isAbsolute(filePath) ? filePath : path.resolve(projectRoot, filePath);
}

/** The path a plan is keyed by: project-relative inside the root, `~/`-prefixed under home, else absolute; forward slashes throughout. The Deployment's tool takes the same form. */
export function normalizePlanPath(projectRoot: string, absPath: string): string {
  const root = projectRoot.endsWith(path.sep) ? projectRoot : projectRoot + path.sep;
  const home = os.homedir();
  const out = absPath.startsWith(root)
    ? absPath.slice(root.length)
    : absPath.startsWith(home + path.sep) ? `~/${absPath.slice(home.length + 1)}` : absPath;
  return out.split(path.sep).join('/');
}

/** The file a keyed path names. */
export const planFilePath = (projectRoot: string, normalized: string): string => resolvePlanDir(normalized, projectRoot);

/** The file's text, or null when it is absent, unreadable, not a file, or larger than the bound. */
export function readPlanFile(absPath: string): string | null {
  try {
    const stat = fs.statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_PLAN_FILE_BYTES) return null;
    return fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
  }
}

/** The plan's title: its first heading, else the file's name. */
export const planTitle = (content: string, filePath: string): string => firstHeading(content) ?? path.basename(filePath, path.extname(filePath));

export interface PlanFileCapture {
  events: OutboundEvent[];
  /** The receipts for `events`; applied with the append. */
  record: (state: SessionState) => void;
}

/** The plan event for a file just written, or none when the session already shipped this content. */
export function planFileCapture(ctx: EnvelopeContext, state: SessionState, projectId: string, projectRoot: string, absPath: string): PlanFileCapture {
  const none: PlanFileCapture = { events: [], record: () => {} };
  const content = readPlanFile(absPath);
  if (content === null) return none;
  const hash = sha256Text(content);
  if (state.planHashes[hash]) return none;
  const normalized = normalizePlanPath(projectRoot, absPath);
  const planKey = planKeyForPath(projectId, normalized);
  return {
    events: [planEvent(ctx, { planKey, content, title: planTitle(content, absPath), originPath: normalized, promptId: state.promptId })],
    record: (next) => { next.planHashes[hash] = planKey; next.planPaths[normalized] = planKey; },
  };
}

/** Every plan file this session has shipped, re-read: the ones whose content changed since are sent again under their key. */
export function planBackstop(ctx: EnvelopeContext, state: SessionState, projectRoot: string): PlanFileCapture {
  const events: OutboundEvent[] = [];
  const receipts: Array<[string, string]> = [];
  for (const [normalized, planKey] of Object.entries(state.planPaths)) {
    const content = readPlanFile(planFilePath(projectRoot, normalized));
    if (content === null) continue;
    const hash = sha256Text(content);
    if (state.planHashes[hash] || receipts.some(([h]) => h === hash)) continue;
    receipts.push([hash, planKey]);
    events.push(planEvent(ctx, { planKey, content, title: planTitle(content, normalized), originPath: normalized, promptId: state.promptId }));
  }
  return { events, record: (next) => { for (const [hash, planKey] of receipts) next.planHashes[hash] = planKey; } };
}
