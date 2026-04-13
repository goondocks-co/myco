/**
 * CLI `task` subcommands — manage agent task definitions via daemon API.
 *
 * Routes through the daemon HTTP API for centralized processing.
 *
 * Subcommands:
 *   task list [--source built-in|user]   List all tasks
 *   task show <name>                     Show a single task with phases
 *   task create <name> --from <template> Copy a template task to user dir
 *   task delete <name>                   Delete a user task
 *   task run <name> [--instruction TEXT] Run a task via the agent
 */

import { connectToDaemon } from './shared.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Column widths for the task list table. */
const COL_NAME_WIDTH = 22;
const COL_SOURCE_WIDTH = 10;
const COL_PHASES_WIDTH = 7;

/** Marker displayed in the Default column for the default task. */
const DEFAULT_MARKER = '*';

// ---------------------------------------------------------------------------
// Types (local — mirrors the API response shape)
// ---------------------------------------------------------------------------

interface PhaseRow {
  name: string;
  maxTurns: number;
  required: boolean;
  model?: string;
  tools: string[];
}

interface TaskRow {
  name: string;
  displayName: string;
  description: string;
  agent: string;
  prompt: string;
  isDefault: boolean;
  source: string;
  isBuiltin: boolean;
  phases?: PhaseRow[];
  model?: string;
  maxTurns?: number;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function padRight(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

function printTaskTable(tasks: TaskRow[]): void {
  const header =
    padRight('Name', COL_NAME_WIDTH) +
    padRight('Source', COL_SOURCE_WIDTH) +
    padRight('Phases', COL_PHASES_WIDTH) +
    'Default';
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const t of tasks) {
    const phaseCount = t.phases?.length ?? 0;
    const row =
      padRight(t.name, COL_NAME_WIDTH) +
      padRight(t.source, COL_SOURCE_WIDTH) +
      padRight(String(phaseCount), COL_PHASES_WIDTH) +
      (t.isDefault ? DEFAULT_MARKER : '');
    console.log(row);
  }
}

function printTaskDetail(task: TaskRow): void {
  console.log(`Name:        ${task.name}`);
  console.log(`Display:     ${task.displayName}`);
  console.log(`Description: ${task.description}`);
  console.log(`Agent:       ${task.agent}`);
  console.log(`Source:      ${task.source}`);
  console.log(`Default:     ${task.isDefault ? 'yes' : 'no'}`);
  if (task.model) console.log(`Model:       ${task.model}`);
  if (task.maxTurns !== undefined) console.log(`Max turns:   ${task.maxTurns}`);
  console.log(`Prompt:      ${task.prompt}`);

  const phases = task.phases ?? [];
  if (phases.length > 0) {
    console.log(`\nPhases (${phases.length}):`);
    for (let i = 0; i < phases.length; i++) {
      const p = phases[i];
      const req = p.required ? 'required' : 'optional';
      const model = p.model ? ` [${p.model}]` : '';
      console.log(`  ${i + 1}. ${p.name} — ${p.maxTurns} turns, ${req}${model}`);
      if (p.tools.length > 0) {
        console.log(`     tools: ${p.tools.join(', ')}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Subcommand handlers
// ---------------------------------------------------------------------------

async function listTasks(args: string[], vaultDir: string): Promise<void> {
  const source = args.find((_, i) => args[i - 1] === '--source');
  const endpoint = source
    ? `/api/agent/tasks?source=${encodeURIComponent(source)}`
    : '/api/agent/tasks';

  const client = await connectToDaemon(vaultDir);
  const result = await client.get(endpoint);

  if (!result.ok || !result.data) {
    console.error('Failed to fetch tasks from daemon');
    process.exit(1);
  }

  const tasks = result.data as TaskRow[];
  if (tasks.length === 0) {
    console.log('No tasks found');
    return;
  }

  printTaskTable(tasks);
}

async function showTask(args: string[], vaultDir: string): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: myco task show <name>');
    process.exit(1);
  }

  const client = await connectToDaemon(vaultDir);
  const result = await client.get(`/api/agent/tasks/${encodeURIComponent(name)}`);

  if (!result.ok || !result.data) {
    console.error(`Task not found: ${name}`);
    process.exit(1);
  }

  printTaskDetail(result.data as TaskRow);
}

async function createTask(args: string[], vaultDir: string): Promise<void> {
  const name = args[0];
  const from = args.find((_, i) => args[i - 1] === '--from');

  if (!name || !from) {
    console.error('Usage: myco task create <name> --from <template>');
    process.exit(1);
  }

  const client = await connectToDaemon(vaultDir);
  const result = await client.post(`/api/agent/tasks/${encodeURIComponent(from)}/copy`, { name });

  if (!result.ok) {
    console.error(`Failed to create task '${name}' from template '${from}'`);
    if (result.data?.error) {
      console.error(`  ${result.data.error}`);
    }
    process.exit(1);
  }

  console.log(`Task '${name}' created from '${from}'`);
}

async function deleteTask(args: string[], vaultDir: string): Promise<void> {
  const name = args[0];
  if (!name) {
    console.error('Usage: myco task delete <name>');
    process.exit(1);
  }

  const client = await connectToDaemon(vaultDir);
  const result = await client.delete(`/api/agent/tasks/${encodeURIComponent(name)}`);

  if (!result.ok) {
    const errCode = result.data?.error as string | undefined;
    if (errCode === 'cannot_delete_builtin') {
      console.error(`Cannot delete built-in task: ${name}`);
    } else if (errCode === 'task_not_found') {
      console.error(`Task not found: ${name}`);
    } else {
      console.error(`Failed to delete task: ${name}`);
    }
    process.exit(1);
  }

  console.log(`Task '${name}' deleted`);
}

async function runTask(args: string[], vaultDir: string): Promise<void> {
  const name = args[0];
  const instruction = args.find((_, i) => args[i - 1] === '--instruction');

  if (!name) {
    console.error('Usage: myco task run <name> [--instruction TEXT]');
    process.exit(1);
  }

  const client = await connectToDaemon(vaultDir);
  console.log('Starting agent...');
  const result = await client.post('/api/agent/run', { task: name, instruction });

  if (!result.ok) {
    console.error('Failed to start agent run');
    process.exit(1);
  }

  console.log('Agent run dispatched to daemon');
  if (result.data?.message) {
    console.log(`  ${result.data.message}`);
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

const TASK_USAGE = `Usage: myco task <subcommand> [args]

Subcommands:
  list [--source built-in|user]   List all tasks
  show <name>                     Show task details and phases
  create <name> --from <template> Copy a task template to your user dir
  delete <name>                   Delete a user task
  run <name> [--instruction TEXT] Run a task via the agent
`;

export async function run(args: string[], vaultDir: string): Promise<void> {
  const subcommand = args[0];
  const subArgs = args.slice(1);

  switch (subcommand) {
    case 'list': return listTasks(subArgs, vaultDir);
    case 'show': return showTask(subArgs, vaultDir);
    case 'create': return createTask(subArgs, vaultDir);
    case 'delete': return deleteTask(subArgs, vaultDir);
    case 'run': return runTask(subArgs, vaultDir);
    default:
      if (subcommand) {
        console.error(`Unknown task subcommand: ${subcommand}`);
      }
      process.stdout.write(TASK_USAGE);
      if (subcommand) process.exit(1);
  }
}
