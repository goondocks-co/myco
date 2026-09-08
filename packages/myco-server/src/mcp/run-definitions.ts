/**
 * The tools only a run may call.
 *
 * A run reaches the catalogued tools where its work is a member's work — every
 * write of vault content, and search. These four are the operations that are
 * the run's own: material reads bounded by its window, its state, its prompt
 * cursor, and its session's titling material and title. They are not in
 * `SERVED_TOOLS`, are never listed to a member or a grant, and have no
 * counterpart in `packages/myco/src/tools/definitions.ts`.
 *
 * A member's inventory returns whole bodies and a run's returns previews under
 * a full-read budget: different operations, so different tools, rather than one
 * tool that behaves two ways depending on who asked.
 */
import { PROJECT_PIVOT, RUN_TOOLS, type RunTool } from '../core/tool-catalogue.js';
import type { ToolDefinition } from './definitions.js';

/** A run-only definition, named from the catalogue so the two cannot drift. */
export type RunToolDefinition = ToolDefinition & { name: RunTool };

export const RUN_PROJECT_DESCRIPTION = 'The Project this run works in. Optional; it may name only that Project.';

const project = { type: 'string', description: RUN_PROJECT_DESCRIPTION } as const;

export const RUN_DEFINITIONS: readonly RunToolDefinition[] = [
  {
    name: 'myco_run',
    description: 'This run\'s own record: file the report that closes it, and read or move the state it carries between passes.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['report', 'state_get', 'state_set'], description: 'report: record what this pass did. state_get: read one key. state_set: move one key, guarded by the version state_get answered.' },
        action: { type: 'string', description: 'For report: the action this pass performed, e.g. extract, digest, skip.' },
        summary: { type: 'string', description: 'For report: one line saying what was done.' },
        details: { type: 'string', description: 'For report: structured detail as a JSON object, serialized.' },
        key: { type: 'string', description: 'For state_get and state_set: the state key.' },
        value: { type: 'string', description: 'For state_set: the value to store.' },
        version: { type: 'string', description: 'For state_set: the version state_get answered. Omit only when the key was unset. A stale version answers applied false and the caller reads again.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_spores',
    description: 'This Project\'s spores as an inventory of bounded previews, and one body in full. Full reads are counted against this run\'s budget, so survey by previews and read in full only what you mean to act on.',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'get'], description: 'list: one preview line per spore, with the total behind the page. get: one spore in full.' },
        id: { type: 'string', description: 'For get: the spore to read.' },
        status: { type: 'string', description: 'For list: filter by status, or "all". Defaults to active.' },
        observation_type: { type: 'string', description: 'For list: filter by observation type.' },
        search: { type: 'string', description: 'For list: keep only spores whose content or type contains this text.' },
        limit: { type: 'number', description: 'For list: page size, clamped to this run\'s window.' },
        offset: { type: 'number', description: 'For list: how many to skip, for paging through the total.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_sessions',
    description: 'This Project\'s settled sessions, and the material and title of the one session this run was dispatched for.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['list', 'material', 'title'], description: 'list: settled sessions, newest first. material: this run\'s own session as titling material. title: write this run\'s own session title and summary.' },
        limit: { type: 'number', description: 'For list: page size, clamped to this run\'s window.' },
        title: { type: 'string', description: 'For title: the new session title.' },
        summary: { type: 'string', description: 'For title: the new session summary.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_prompts',
    description: 'The prompts extraction has not read yet, oldest first, and the mark that removes one from that page.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['unprocessed', 'mark_processed'], description: 'unprocessed: one page of prompts not yet read. mark_processed: mark one prompt read.' },
        prompt_id: { type: 'string', description: 'For mark_processed: the prompt to mark.' },
        cursor: { type: 'string', description: 'For unprocessed: the next_cursor from the previous page.' },
        limit: { type: 'number', description: 'For unprocessed: page size, clamped to this run\'s window.' },
        include_active: { type: 'boolean', description: 'For unprocessed: include prompts of sessions still in flight. Defaults to false.' },
        include_text: { type: 'boolean', description: 'For unprocessed: include each prompt\'s body. Defaults to false, which reads no bodies at all.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
];

/** One run-only definition by name, or undefined. */
export function runDefinitionOf(name: string): RunToolDefinition | undefined {
  return RUN_DEFINITIONS.find((d) => d.name === name);
}

export { RUN_TOOLS };
