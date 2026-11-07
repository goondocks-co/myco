/**
 * One step a run's worker saw, in a reader's words. The run's panel words every step with this, and "Running now"
 * words a live run's latest step with it, so the two never say the same step differently. No harness is named: a
 * step reads by its kind, and what a harness's own tools did reads from its manifest's words (`STEP_WORDS`).
 */
import { callWords } from './call-words.js';
import { STEP_WORDS } from './runner-step-words.generated.js';
import type { StepKind } from './worker-steps.js';

/** The mark a shaped form carries where it kept no word. */
export const ELIDED = '…';

/** Leads for a step by its kind: with a target, and without one. */
const STEP_LEADS: Readonly<Record<Exclude<StepKind, 'myco' | 'tool'>, readonly [string, string]>> = {
  read: ['Read', 'Read a file'],
  search: ['Searched', 'Searched the files'],
  edit: ['Edited', 'Edited a file'],
  command: ['Ran', 'Ran a command'],
  fetch: ['Looked up', 'Looked something up online'],
};

/** The names a step falls back to where its harness names a call nothing narrower. */
const UNNAMED_TOOLS: ReadonlySet<string> = new Set(['tool', 'call', 'other']);

/** The Myco tool a step names: its tool's last segment where that is a `myco_…` name, as Myco records the call. */
export function mycoToolOf(stepTool: string): string {
  const tail = stepTool.split(/__|[./:]/).at(-1) ?? stepTool;
  return /^myco_[a-z_]+$/.test(tail) ? tail : stepTool;
}

/** A tool's name in plain words: `ToolSearch` reads "tool search", `web_fetch` reads "web fetch". */
function plainName(tool: string): string {
  return tool.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-.:/]+/g, ' ').trim().toLowerCase();
}

/** A target worth showing: one that keeps at least one word. */
export const shownTarget = (target: string | null): string | null => (target === null || target.replaceAll(ELIDED, '').trim() === '' ? null : target);

/** What one step did, and the shaped target it aimed at where it keeps a word. */
export function stepWords(step: { kind: StepKind; tool: string; target: string | null }, harness: string | null): { lead: string; target: string | null } {
  if (step.kind === 'myco') return { lead: callWords(mycoToolOf(step.tool), step.target), target: null };
  if (step.kind === 'tool') {
    const words = harness === null ? undefined : STEP_WORDS[harness]?.[step.tool];
    return { lead: words ?? (UNNAMED_TOOLS.has(step.tool) ? 'Used a tool' : `Used ${plainName(step.tool)}`), target: null };
  }
  const target = shownTarget(step.target);
  const [withTarget, without] = STEP_LEADS[step.kind];
  return target === null ? { lead: without, target: null } : { lead: withTarget, target };
}
