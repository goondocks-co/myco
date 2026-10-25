/**
 * The tools only a run may call.
 *
 * A run reaches the catalogued tools where its work is a member's work — every
 * write of vault content, and search. These are the operations that are the
 * run's own: material reads bounded by its window, its state, its material
 * acknowledgements, its session's titling material and title, and the repository map a
 * map run keeps. They are not in
 * `SERVED_TOOLS`, are never listed to a member or a grant, and have no
 * counterpart in `packages/myco/src/tools/definitions.ts`.
 *
 * A member's inventory returns whole bodies and a run's returns previews under
 * a full-read budget: different operations, so different tools, rather than one
 * tool that behaves two ways depending on who asked.
 */
import { MAP_WRITE_BOUNDS } from '@goondocks/myco-shared/canopy';
import { PROJECT_PIVOT, RUN_TOOLS, type RunTool } from '../core/tool-catalogue.js';
import type { ToolDefinition } from './definitions.js';

/** A run-only definition, named from the catalogue so the two cannot drift. */
export type RunToolDefinition = ToolDefinition & { name: RunTool };

export const RUN_PROJECT_DESCRIPTION = 'The Project this run works in. Optional; it may name only that Project.';

const project = { type: 'string', description: RUN_PROJECT_DESCRIPTION } as const;

export const RUN_DEFINITIONS: readonly RunToolDefinition[] = [
  {
    name: 'myco_run',
    description: 'This run\'s own record: file its report with op "report", action, summary and audit, or read or move its state. Every call requires an explicit op. After an accepted report, end your response; no further closing call is needed.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['report', 'state_get', 'state_set'], description: 'report: record what this pass did. state_get: read one key. state_set: move one key, guarded by the version state_get answered.' },
        action: { type: 'string', description: 'For report: the action this pass performed, one of the actions this run\'s task closes with, e.g. extract, seed, summary, skip.' },
        summary: { type: 'string', description: 'For report: one line saying what was done.' },
        details: { type: 'string', description: 'For report: structured detail as a JSON object, serialized.' },
        audit: { type: ['object', 'string'], description: 'For report, required: your account of this pass, as an object of steps (what you did, in order), examined (files and areas read), commands (commands run), failures (each failure as {what, recovery}) and reasoning (why the outcome is what it is). Empty lists where nothing applies.' },
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
    description: 'Acknowledge material served to this run using its ledger identity.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['mark_processed'], description: 'mark_processed: acknowledge one item using its served_id.' },
        served_id: { type: 'string', description: 'For mark_processed: acknowledge this item using the served_id from its served material.' },
        prompt_id: { type: 'string', description: 'Compatibility for mark_processed: a prompt served to this run. Ambiguous instances require served_id.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_map',
    description: 'This Project\'s repository map, for the run that keeps it: the current map and whether it was already read from this run\'s commit, and the one write of the new map.',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['get', 'write'], description: 'get: the current map, this run\'s commit, and unchanged true when the map was already read from it. write: store the new map, once per run.' },
        artifact: { type: ['object', 'string'], description: `For write: the map as one JSON object or a JSON object string. ${MAP_WRITE_BOUNDS}` },
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
