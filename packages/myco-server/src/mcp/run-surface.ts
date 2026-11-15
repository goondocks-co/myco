import { CURATION_SEARCH_LIMIT, CURATION_SEARCH_RESULTS, CURATION_CLUSTER_CAP, CURATION_CONSOLIDATE_MIN, CURATION_CONSOLIDATE_EXAMPLE } from '../core/spore-curation-contract.js';
import { AGENT_LINE_MAX_CHARS, AGENT_LINE_GUIDANCE } from '../core/injection.js';
import { CURATION_TASK, EXTRACTION_TASK, SEEDING_TASK } from '../core/task-catalogue.js';
import { acceptedActions } from '../core/run-postconditions.js';
/**
 * The run-scoped surface: what a run's credential may call over MCP.
 *
 * A task file declares its tools in the task vocabulary (`vault_*`); the tool
 * surface judges `(tool, op)`. This is the one map between them, an explicit
 * allowlist in the shape of the external surface (`external.ts`): fail-closed,
 * never a name filter, never a `readOnlyHint` denylist.
 *
 * The surface is two sets. Where a run's work is a member's work — every write
 * of vault content, and search — it calls the catalogued tools, so one
 * operation has one implementation and one attribution path. Where the
 * operation is the run's own — material reads bounded by its window, its state,
 * its learning slices, its session's material and title, the map it keeps — it calls the run-only
 * tools (`run-definitions.ts`), which no member and no grant can see.
 *
 * `report` is the exception to the allowlist and is served to every run. A
 * report is the run protocol rather than a task capability: the close gate
 * makes one the condition of completing, and a task declaring no tools of its
 * own still has to close.
 *
 * A view over the registries: nothing here resolves an op or dispatches a call.
 */
import { RUN_TOOLS, NO_OP } from '../core/tool-catalogue.js';
import {
  ALWAYS_ALLOWED,
  isRunCall,
  RUN_TOOL_MAP,
  runAllowlist,
  type RunAllowlist,
} from './run-allowlist.js';
import { narrowDefinitions } from './external.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from './definitions.js';
import { RUN_DEFINITIONS, RUN_PROJECT_DESCRIPTION } from './run-definitions.js';
import { toolPolicy, type RegistryEntry, type ToolHandler } from './registry.js';
import type { Action } from '../auth/authorization.js';
import { handleRun } from './tools/run.js';
import { handleRunMap } from './tools/run-map.js';
import { handleRunSessions } from './tools/run-sessions.js';
import { handleRunSpores } from './tools/run-spores.js';
import { handleRunCuration } from './tools/run-curation.js';
import { handleRunCards } from './tools/run-cards.js';
import { handleRunLearning } from './tools/run-learning.js';
import { handleRunPlans } from './tools/run-plans.js';

/** The handlers for the run-only tools, keyed as the served registry is. */
const runOperation = (handler: ToolHandler, action: Action): RegistryEntry => ({
  handler,
  authorization: toolPolicy('run', action, ['run']),
});

export const RUN_TOOL_REGISTRY: Record<string, { defaultOp: string; ops: Record<string, RegistryEntry> }> = {
  myco_run: {
    defaultOp: 'report',
    ops: {
      report: runOperation(handleRun, 'execute'),
      state_get: runOperation(handleRun, 'read'),
      state_set: runOperation(handleRun, 'execute'),
    },
  },
  myco_run_spores: { defaultOp: 'list', ops: { list: runOperation(handleRunSpores, 'read'), get: runOperation(handleRunSpores, 'read') } },
  myco_run_sessions: {
    defaultOp: 'list',
    ops: {
      list: runOperation(handleRunSessions, 'read'),
      material: runOperation(handleRunSessions, 'read'),
      title: runOperation(handleRunSessions, 'execute'),
    },
  },
  myco_run_map: { defaultOp: 'get', ops: { get: runOperation(handleRunMap, 'read'), write: runOperation(handleRunMap, 'execute') } },
  myco_run_curation: {
    defaultOp: 'complete',
    ops: { material: runOperation(handleRunCuration, 'execute'), complete: runOperation(handleRunCuration, 'execute') },
  },
  myco_run_plans: { defaultOp: 'resolve', ops: { resolve: runOperation(handleRunPlans, 'execute') } },
  myco_run_cards: {
    defaultOp: 'material',
    ops: { material: runOperation(handleRunCards, 'read'), write: runOperation(handleRunCards, 'execute') },
  },
  myco_run_learning: {
    defaultOp: 'material',
    ops: {
      material: runOperation(handleRunLearning, 'read'),
      get: runOperation(handleRunLearning, 'read'),
      complete: runOperation(handleRunLearning, 'execute'),
    },
  },
};

export { ALWAYS_ALLOWED, isRunCall, RUN_TOOL_MAP, runAllowlist, type RunAllowlist };

/** The write guidance and session provenance admitted for the run's task. */
function runSporeDefinition(definition: ToolDefinition, task: string | null): ToolDefinition {
  const curation = task === CURATION_TASK;
  const extraction = task === EXTRACTION_TASK;
  const session = extraction
    ? 'For save and consolidate, supply the supporting whole session served in learning material. For supersede and obsolete, omit session_id or name only the session bound to this run.'
    : 'Omit session_id: this run names no session. Sources retain their own provenance.';
  const example = JSON.stringify({ op: 'save', ...(extraction ? { session_id: '<supporting session id>' } : {}),
    type: 'gotcha', content: 'Delivery requires the outbox lease.', agent_line: 'When delivery stalls, check the outbox lease before retrying.' });
  const guidance = curation
    ? `For curation runs, consolidate ${CURATION_CONSOLIDATE_MIN} to ${CURATION_CLUSTER_CAP} distinct whole-read {id,revision} sources into wisdom; correct and retry invalid input once before reporting, or complete keep with the read members. Consolidate example: ${CURATION_CONSOLIDATE_EXAMPLE}`
    : extraction || task === SEEDING_TASK ? `Record durable knowledge from this run's admitted material. Save example: ${example}`
    : "Use the operations and source material admitted for this run's task.";
  const lifecycle = curation || extraction ? ' Lifecycle writes require active sources at the exact revisions read; obsolete requires reason.' : '';
  const properties = definition.inputSchema.properties;
  const { cortex: _memberGuidance, ...run } = definition;
  return {
    ...run,
    description: `Operations: ${properties.op.enum!.join(', ')}. ${guidance} ${session} ${extraction ? 'Save and consolidate require' : curation ? 'Consolidate requires' : 'Save requires'} agent_line, normalized to one nonempty line of at most ${AGENT_LINE_MAX_CHARS} characters. ${AGENT_LINE_GUIDANCE}${lifecycle}`,
    inputSchema: { ...definition.inputSchema, properties: { ...properties,
      session_id: { ...properties.session_id, description: session },
      prompt_id: { ...properties.prompt_id, description: extraction ? 'Compatibility for extraction runs dispatched before the served-material ledger: the captured prompt resolves the supporting session. Use session_id from learning material for current runs.' : 'Omit prompt_id for this run.' },
      expect_status: { ...properties.expect_status, description: 'Run lifecycle writes require active sources.' },
      expect_revision: { ...properties.expect_revision, description: 'Required for supersede and obsolete: the exact source revision read.' },
      provenance_kind: { ...properties.provenance_kind, description: 'Optional PR or commit provenance; give with provenance_ref.' },
    } },
  };
}

/** The definitions a run is listed: its allowlisted names across both sets, each op enum narrowed to what it may call. */
export function runDefinitions(allow: RunAllowlist, task: string | null = null): ToolDefinition[] {
  const actions = acceptedActions(task);
  const definitions = narrowDefinitions([...TOOL_DEFINITIONS, ...RUN_DEFINITIONS], Object.fromEntries(allow), RUN_PROJECT_DESCRIPTION);
  return definitions.map((definition) => {
    if (definition.name === 'myco_spores') return runSporeDefinition(definition, task);
    if (definition.name === 'myco_search' && task === CURATION_TASK) {
      const bounds = `This curation run may search at most ${CURATION_SEARCH_LIMIT} times; each call returns up to ${CURATION_SEARCH_RESULTS} active spore matches, using semantic search.`;
      return {
        ...definition,
        description: `${bounds} ${definition.description}`,
        inputSchema: {
          ...definition.inputSchema,
          properties: {
            ...definition.inputSchema.properties,
            query: { ...definition.inputSchema.properties.query, description: `${bounds} Supply the topic to compare.` },
          },
        },
      };
    }

    if (definition.name !== 'myco_run' || actions === null) return definition;
    const baseExample = definition.inputSchema.examples![0]!;
    const example = { ...baseExample, action: actions[0] };
    const contextual = (text: string) => text.replace(JSON.stringify(baseExample), JSON.stringify(example));
    return {
      ...definition,
      handlerValidated: [...(definition.handlerValidated ?? []), 'action'],
      inputRepair: definition.inputRepair === undefined ? undefined : contextual(definition.inputRepair),
      description: `This task reports action ${actions.join(' or ')}. ${contextual(definition.description)}`,
      inputSchema: {
        ...definition.inputSchema,
        examples: [example],
        properties: { ...definition.inputSchema.properties, action: { ...definition.inputSchema.properties.action, enum: actions } },
      },
    };
  });
}

/** Every operation a Myco tool takes, served or run-only: the only operations a step a worker names a Myco call keeps. */
export const MYCO_TOOL_OPS: ReadonlySet<string> = new Set(
  [...TOOL_DEFINITIONS, ...RUN_DEFINITIONS].flatMap((definition) =>
    (definition.inputSchema.properties.op?.enum ?? []).filter((op): op is string => typeof op === 'string'),
  ),
);
