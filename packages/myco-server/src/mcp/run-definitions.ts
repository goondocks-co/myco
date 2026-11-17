import { TURN_SOURCE_PAGES, TURN_SOURCE_CURSOR_MAX_CHARS, TURN_SOURCE_MAX_BYTES, TURN_SOURCE_FAILURE_LIMIT } from '../core/turn-source.js';
import { CARD_TEXT_FIELDS, CARD_LIST_FIELDS, CARD_PAIR_FIELDS } from '@goondocks/myco-shared/turn-card';
import { CARD_MAX_CHARS, RUN_ANSWER_BYTES, readWindowFor } from '../core/read-window.js';
import { HANDOFF_MAX_BYTES } from '../core/learning-sessions.js';
import { TITLE_MAX_CHARS, SUMMARY_MAX_CHARS } from '../core/titling-params.js';
import { MAX_REPORT_DETAILS_CHARS, MAX_REPORT_SUMMARY_CHARS } from '../core/run-postconditions.js';
import {
  RUN_AUDIT_SHAPE,
  MAX_AUDIT_CHARS,
  MAX_ITEM_CHARS,
  MAX_REASONING_CHARS,
  MAX_STEPS,
  MAX_LISTED,
  MAX_FAILURES,
} from '../core/run-audit.js';
import {
  RUN_ACTION_MAX_CHARS,
  RUN_KEY_MAX_CHARS,
  RUN_VERSION_CHARS,
  RUN_SPORE_ID_MAX_CHARS,
  RUN_SPORE_CURSOR_MAX_CHARS,
} from '../core/run-tool-contract.js';
import { CURATION_ANSWER_BOUNDS, CURATION_ANSWER_EXAMPLE, CURATION_BODY_CHARS, CURATION_CLUSTER_CAP, CURATION_NEW_NOTES, CURATION_REASON_CHARS, CURATION_TYPES } from '../core/spore-curation-contract.js';
import { AGENT_LINE_MAX_CHARS } from '../core/injection.js';
import { CARD_WRITE_BOUND } from '../core/turn-card-prompt.js';
import { PLAN_DECISIONS, PLAN_DECISION_EVIDENCE, PLAN_DECISION_EXAMPLE, PLAN_RESOLUTION_NOTE_CHARS } from '../core/plan-curation.js';
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
import { MAP_WRITE_BOUNDS, MAP_LIMITS } from '@goondocks/myco-shared/canopy';
import { PROJECT_PIVOT, type RunTool } from '../core/tool-catalogue.js';
import { searchInstead, type ToolDefinition, type JsonSchemaProperty } from './definitions.js';

/** A run-only definition, named from the catalogue so the two cannot drift. */
type RunToolDefinition = ToolDefinition & { name: RunTool };

export const RUN_PROJECT_DESCRIPTION = 'The Project this run works in. Optional; it may name only that Project.';

const project = { type: 'string', description: RUN_PROJECT_DESCRIPTION } as const;

const window = readWindowFor(null);
const text = (maxLength?: number): JsonSchemaProperty => ({
  type: 'string',
  ...(maxLength === undefined ? {} : { minLength: 1, maxLength }),
});
const cardProperties: Record<string, JsonSchemaProperty> = Object.fromEntries([
  ...CARD_TEXT_FIELDS.map((field) => [field, text()]),
  ...CARD_LIST_FIELDS.map((field) => [field, { type: 'array', items: text() }]),
  ...CARD_PAIR_FIELDS.map(([field, a, b]) => [
    field,
    { type: 'array', items: { type: 'object', properties: { [a]: text(), [b]: text() }, required: [a, b] } },
  ]),
]);
const annotation: JsonSchemaProperty = {
  type: 'object',
  properties: {
    path: text(MAP_LIMITS.path),
    annotation: text(MAP_LIMITS.annotation),
    groundedIn: {
      type: 'array',
      minItems: 1,
      maxItems: MAP_LIMITS.groundedIn,
      items: {
        type: 'object',
        properties: { path: text(MAP_LIMITS.path), sha256: { ...text(MAP_LIMITS.sha256), minLength: MAP_LIMITS.sha256 } },
        required: ['path', 'sha256'],
      },
    },
  },
  required: ['path', 'annotation', 'groundedIn'],
};

export const RUN_EXAMPLES: Record<RunTool, Record<string, unknown>> = {
  myco_run: {
    op: 'report',
    action: 'extract',
    summary: 'Recorded the durable guidance.',
    audit: {
      steps: ['Read the assigned material.'],
      examined: [],
      commands: [],
      failures: [],
      reasoning: 'The served turns contained actionable guidance.',
    },
  },
  myco_run_spores: { op: 'get', id: 'spore-a' },
  myco_run_sessions: { op: 'title', title: 'Repairing capture delivery', summary: 'Preserved queued capture while repairing delivery.' },
  myco_run_map: {
    op: 'write',
    artifact: {
      directories: [
        { path: 'src', annotation: 'Application source.', groundedIn: [{ path: 'src/index.ts', sha256: 'a'.repeat(MAP_LIMITS.sha256) }] },
      ],
      domains: [
        {
          id: 'capture',
          title: 'Capture',
          files: [
            {
              path: 'src/index.ts',
              annotation: 'Application entry.',
              groundedIn: [{ path: 'src/index.ts', sha256: 'a'.repeat(MAP_LIMITS.sha256) }],
            },
          ],
        },
      ],
    },
  },
  myco_run_cards: {
    op: 'write',
    revision: 'revision-from-material',
    cards: [
      {
        turns: ['turn-key-from-material'],
        signal: 'high',
        card: {
          asked: 'Repair delivery.',
          done: 'Retained the queue.',
          outcome: 'done',
          decisions: [],
          rejected: [],
          errors: [],
          corrections: [],
          files: [],
          commands: [],
          open_questions: [],
        },
      },
    ],
  },
  myco_run_learning: { op: 'complete', handoff: 'No unresolved guidance.' },
  myco_run_curation: CURATION_ANSWER_EXAMPLE,
  myco_run_plans: PLAN_DECISION_EXAMPLE,
};

const definitions: readonly RunToolDefinition[] = [
  {
    name: 'myco_run_curation',
    handlerValidated: ['*'],
    inputRepair: CURATION_ANSWER_BOUNDS,
    description: `Submit the entire offered group in one answer. The server checks exact member ids and current revisions, then applies everything atomically; a dry run stores the checked answer without applying it. No reading or reporting tools are available. ${CURATION_ANSWER_BOUNDS}`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['answer'] },
        notes: { type: 'array', maxItems: CURATION_NEW_NOTES, items: {
          type: 'object', properties: {
            sources: { type: 'array', minItems: 1, maxItems: CURATION_CLUSTER_CAP, items: text() },
            observation_type: { type: 'string', enum: [...CURATION_TYPES] },
            agent_line: text(AGENT_LINE_MAX_CHARS),
            content: text(CURATION_BODY_CHARS),
          }, required: ['sources','observation_type','agent_line','content'],
        } },
        keep: { type: 'array', maxItems: CURATION_CLUSTER_CAP, items: text() },
        retire: { type: 'array', maxItems: CURATION_CLUSTER_CAP, items: {
          type: 'object', properties: { id: text(), reason: text(CURATION_REASON_CHARS), made_unnecessary_by: text() },
          required: ['id','reason','made_unnecessary_by'],
        } },
        reason: text(CURATION_REASON_CHARS),
        [PROJECT_PIVOT]: project,
      },
      required: ['op', 'notes', 'keep', 'retire', 'reason'],
    },
  },

  {
    name: 'myco_run_plans',
    handlerValidated: ['plan_id', 'evidence', 'superseded_by'],
    description: `Record what became of one assigned plan, once per plan: completed, abandoned, superseded by another plan, or open. A completed, abandoned or superseded decision cites 1 to ${PLAN_DECISION_EVIDENCE} distinct evidence ids listed for that plan, or plan:<id> for another plan this Project holds; superseded also names superseded_by. note is nonempty text of at most ${PLAN_RESOLUTION_NOTE_CHARS} characters. The decision changes the plan's status and resolution, never its body, and lands only on the plan as this run read it.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['resolve'], description: 'resolve: record the decision for one assigned plan.' },
        plan_id: { type: 'string', minLength: 1, description: 'An assigned plan, as the material names it.' },
        decision: { type: 'string', enum: [...PLAN_DECISIONS] },
        note: { type: 'string', minLength: 1, maxLength: PLAN_RESOLUTION_NOTE_CHARS, description: `What landed, why it was dropped, what carries it on, or what is pending: at most ${PLAN_RESOLUTION_NOTE_CHARS} characters.` },
        evidence: {
          type: 'array', maxItems: PLAN_DECISION_EVIDENCE, items: { type: 'string', minLength: 1 },
          description: `The evidence ids the decision rests on, as the material lists them (progress, session:<id>, pr:<id>, issue:<id>, tag:<id>, release:<id>, deploy:<id>) or plan:<id>. At least 1 for a status change, at most ${PLAN_DECISION_EVIDENCE}. Example: ["pr:2180"].`,
        },
        superseded_by: { type: 'string', minLength: 1, description: 'For superseded: the later plan that carries the work on.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op', 'plan_id', 'decision', 'note'],
    },
  },
  {
    name: 'myco_run',
    description: `Limits: action ${RUN_ACTION_MAX_CHARS} characters; report summary ${MAX_REPORT_SUMMARY_CHARS}; details ${MAX_REPORT_DETAILS_CHARS}; serialized audit ${MAX_AUDIT_CHARS}. State key ${RUN_KEY_MAX_CHARS} characters; version ${RUN_VERSION_CHARS}; value must fit a ${RUN_ANSWER_BYTES}-byte JSON answer. ${RUN_AUDIT_SHAPE}. This run's own record: file its report with op "report", action, summary and audit, or read or move its state. Every call requires an explicit op. After an accepted report, end your response; no further closing call is needed.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['report', 'state_get', 'state_set'],
          description:
            'report: record what this pass did. state_get: read one key. state_set: move one key, guarded by the version state_get answered.',
        },
        action: {
          type: 'string',
          minLength: 1,
          maxLength: RUN_ACTION_MAX_CHARS,
          description:
            "For report: the action this pass performed, one of the actions this run's task closes with, e.g. extract, seed, summary, skip.",
        },
        summary: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REPORT_SUMMARY_CHARS,
          description: 'For report: one line saying what was done.',
        },
        details: {
          type: 'string',
          minLength: 1,
          maxLength: MAX_REPORT_DETAILS_CHARS,
          description: 'For report: structured detail as a JSON object, serialized.',
        },
        audit: {
          type: ['object', 'string'],
          maxLength: MAX_AUDIT_CHARS,
          properties: {
            steps: { type: 'array', minItems: 1, maxItems: MAX_STEPS, items: { type: 'string', maxLength: MAX_ITEM_CHARS } },
            examined: { type: 'array', maxItems: MAX_LISTED, items: { type: 'string', maxLength: MAX_ITEM_CHARS } },
            commands: { type: 'array', maxItems: MAX_LISTED, items: { type: 'string', maxLength: MAX_ITEM_CHARS } },
            failures: {
              type: 'array',
              maxItems: MAX_FAILURES,
              items: {
                type: 'object',
                properties: {
                  what: { type: 'string', maxLength: MAX_ITEM_CHARS },
                  recovery: { type: 'string', maxLength: MAX_ITEM_CHARS },
                },
                required: ['what', 'recovery'],
              },
            },
            reasoning: { type: 'string', minLength: 1, maxLength: MAX_REASONING_CHARS },
          },
          required: ['steps', 'reasoning'],
          description:
            'For report, required: your account of this pass, as an object of steps (what you did, in order), examined (files and areas read), commands (commands run), failures (each failure as {what, recovery}) and reasoning (why the outcome is what it is). Empty lists where nothing applies.',
        },
        key: { type: 'string', minLength: 1, maxLength: RUN_KEY_MAX_CHARS, description: 'For state_get and state_set: the state key.' },
        offset: {
          type: 'integer',
          minimum: 0,
          description:
            'For state_get: where to read from, for a value longer than one answer. An answer names its next_offset until the last; a call past offset 0 also carries the version offset 0 answered, and a state_changed refusal means restart at offset 0.',
        },
        value: {
          type: 'string',
          minLength: 1,
          description: `For state_set: nonempty text that fits one ${RUN_ANSWER_BYTES}-byte JSON answer, including key and version.`,
        },
        version: {
          type: 'string',
          minLength: RUN_VERSION_CHARS,
          maxLength: RUN_VERSION_CHARS,
          description:
            'For state_set: the version state_get answered. Omit only when the key was unset. A stale version answers applied false and the caller reads again. For state_get past offset 0: the version offset 0 answered.',
        },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    retiredArguments: {
      search: searchInstead('active'),
      offset: (input) => ({ actual: 'offset paging is retired: the inventory continues by the cursor its last page answered', next: { tool: 'myco_run_spores', op: 'list', ...(input.status === undefined ? {} : { status: input.status }), cursor: '<cursor from the last page>' } }),
    },
    name: 'myco_run_spores',
    description: `Read limits: ${window.sporeFullReads} full reads; ${window.sporePage} previews per page; ${window.sporeBodyChars} characters per long body field; ids and observation types ${RUN_SPORE_ID_MAX_CHARS} characters; page cursors ${RUN_SPORE_CURSOR_MAX_CHARS} characters. This Project's spores as an inventory of bounded previews, newest first, a page at a time by cursor, and one body in full; to find spores by what they say, use myco_search with type spore where this run has it. Full reads are counted against this run\'s budget, so survey by previews and read in full only what you mean to act on.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'get'],
          description: 'list: one preview line per spore, with has_more, the next page\'s cursor, and the total by status and type. get: one spore in full.',
        },
        id: { type: 'string', minLength: 1, maxLength: RUN_SPORE_ID_MAX_CHARS, description: 'For get: the spore to read.' },
        max_chars: {
          type: 'integer',
          minimum: 1,
          maximum: window.sporeBodyChars,
          description: 'For get: the most characters of each long field to answer, to ask for less. An answer cut to fit says truncated.',
        },
        status: { type: 'string', description: 'For list: filter by status, or "all". Defaults to active.' },
        observation_type: {
          type: 'string',
          minLength: 1,
          maxLength: RUN_SPORE_ID_MAX_CHARS,
          description: 'For list: filter by observation type.',
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: window.sporePage,
          description: `For list: at most ${window.sporePage} spores per page; larger requests are clamped.`,
        },
        cursor: { type: 'string', minLength: 1, maxLength: RUN_SPORE_CURSOR_MAX_CHARS, description: 'For list: the cursor the previous page answered; the inventory continues after it. Example: {"op":"list","status":"active","cursor":"1762300000000:3f0c"}' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_sessions',
    description: `This Project's settled sessions (up to ${window.sessionPage} per page), and this run's session. title and summary are both required for title: title 1–${TITLE_MAX_CHARS} characters, summary 1–${SUMMARY_MAX_CHARS} characters after cleanup.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['list', 'material', 'title'],
          description:
            "list: settled sessions, newest first. material: this run's own session as titling material. title: write this run's own session title and summary.",
        },
        limit: {
          type: 'integer',
          minimum: 1,
          maximum: window.sessionPage,
          description: `For list: at most ${window.sessionPage} sessions per page; larger requests are clamped.`,
        },
        title: { type: 'string', minLength: 1, maxLength: TITLE_MAX_CHARS, description: 'For title: the new session title.' },
        summary: { type: 'string', minLength: 1, maxLength: SUMMARY_MAX_CHARS, description: 'For title: the new session summary.' },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_map',
    description: `This Project's repository map: get the current map, then write once per run and report. ${MAP_WRITE_BOUNDS}`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['get', 'write'],
          description:
            "get: the current map, this run's commit, and unchanged true when the map was already read from it. write: store the new map, once per run.",
        },
        artifact: {
          type: ['object', 'string'],
          properties: {
            directories: { type: 'array', minItems: 1, maxItems: MAP_LIMITS.directories, items: annotation },
            domains: {
              type: 'array',
              minItems: 1,
              maxItems: MAP_LIMITS.domains,
              items: {
                type: 'object',
                properties: {
                  id: text(MAP_LIMITS.id),
                  title: text(MAP_LIMITS.title),
                  files: { type: 'array', minItems: 1, maxItems: MAP_LIMITS.files, items: annotation },
                },
                required: ['id', 'title', 'files'],
              },
            },
          },
          required: ['directories', 'domains'],
          description: `For write: the map as one JSON object or a JSON object string. ${MAP_WRITE_BOUNDS}`,
        },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_cards',
    description: `The turns this card run was assigned: read their trimmed inputs, then write one card per turn. When complete is false and partial_reason is absent, call get with turn_key and follow next_cursor as cursor until complete is true before writing that turn. Other cards can be written immediately; a mixed write answers written plus refused cards. A partial_reason means write from the excerpt: the card remains visibly partial. A full source above ${TURN_SOURCE_MAX_BYTES} raw UTF-8 bytes, a missing stored body, or ${TURN_SOURCE_FAILURE_LIMIT} consecutive failed full-read runs uses this partial disposition. Raw answers are at most ${RUN_ANSWER_BYTES} UTF-8 bytes, with at most ${TURN_SOURCE_PAGES} source page and one record body opened per request; an unfinished read counts toward the consecutive failure limit when its run fails. Example: {"op":"get","turn_key":"turn-a"}. Each rendered card is at most ${CARD_MAX_CHARS} characters. ${CARD_WRITE_BOUND}`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['material', 'get', 'write'],
          description:
            'material: the assigned turns with turn_key, trimmed input and complete, a page at a time. get: full source from the first record or cursor. write: a subset of the assigned cards, repeated until all turns are written.',
        },
        turn_key: { type: 'string', minLength: 1, maxLength: RUN_KEY_MAX_CHARS, description: `For get: an assigned turn, up to ${TURN_SOURCE_MAX_BYTES} total raw UTF-8 bytes read by this attempt; restarting does not reset this allowance. A partial_reason means write its card from the excerpt instead.` },
        cursor: { type: 'string', maxLength: TURN_SOURCE_CURSOR_MAX_CHARS, description: 'For get continuation: next_cursor from the preceding answer. Omit to restart at the first source record.' },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'For material: the page to read, from 1. An answer names its next_page until the last.',
        },
        revision: {
          type: 'string',
          description: 'For material past page 1 and every card write: the revision the earlier pages answered.',
        },
        cards: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              turns: { type: 'array', minItems: 1, items: text() },
              signal: { type: 'string', enum: ['none', 'low', 'high'] },
              card: { type: 'object', properties: cardProperties, required: Object.keys(cardProperties) },
            },
            required: ['turns', 'signal', 'card'],
          },
          description: `Each rendered card is at most ${CARD_MAX_CHARS} characters. For write: [{ turns: [turn_key…], signal: "none"|"low"|"high", card: { asked, done, outcome, decisions, rejected, errors, corrections, files, commands, open_questions } }]. Across write calls, every served turn_key appears in exactly one card. If material serves no turns, write [].`,
        },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
  {
    name: 'myco_run_learning',
    description: `Read every page before writing spores or completing this learning slice. Open raw turns only for high-signal cards; follow next_cursor as cursor only as far as needed; optional raw reads never block saves or completion. Raw answers are at most ${RUN_ANSWER_BYTES} UTF-8 bytes, opening at most ${TURN_SOURCE_PAGES} source page and one record body per request; stop this optional read when enough detail is available. Example: {"op":"get","turn_key":"turn-a"}. The completion handoff is at most ${HANDOFF_MAX_BYTES} UTF-8 bytes.`,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      type: 'object',
      properties: {
        op: {
          type: 'string',
          enum: ['material', 'get', 'complete'],
          description:
            "material: the slice's cards a page at a time, with the previous slice's handoff on page 1. get: one raw turn of a high-signal card, by turn_key. complete: mark the slice learned, with a handoff for the next. Spore writes and complete wait until every page is read.",
        },
        turn_key: { type: 'string', minLength: 1, maxLength: RUN_KEY_MAX_CHARS, description: 'For get: an assigned turn to read in full.' },
        cursor: { type: 'string', maxLength: TURN_SOURCE_CURSOR_MAX_CHARS, description: 'For get continuation: next_cursor from the preceding answer. Omit to restart at the first source record.' },
        page: {
          type: 'integer',
          minimum: 1,
          description: 'For material: the page to read, from 1. An answer names its next_page until the last.',
        },
        revision: { type: 'string', description: 'For material past page 1: the revision the earlier pages answered.' },
        handoff: {
          type: 'string',
          description: `For complete: at most ${HANDOFF_MAX_BYTES} UTF-8 bytes for the next slice.`,
        },
        [PROJECT_PIVOT]: project,
      },
      required: ['op'],
    },
  },
];

export const RUN_DEFINITIONS: readonly RunToolDefinition[] = definitions.map((definition) => ({
  ...definition,
  inputRepair:
    definition.inputRepair ??
    `Correct the named input and call ${definition.name} again with its explicit op. Example: ${JSON.stringify(RUN_EXAMPLES[definition.name])}`,
  description: `${definition.description} Example: ${JSON.stringify(RUN_EXAMPLES[definition.name])}`,
  inputSchema: { ...definition.inputSchema, examples: [RUN_EXAMPLES[definition.name]] },
}));

