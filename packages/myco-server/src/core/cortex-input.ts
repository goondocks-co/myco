/**
 * The input a Cortex run is handed, built by the server: the prompt a
 * `cortex-instructions` run authors from, and the one a `digest-only` run
 * regenerates its extracts from.
 *
 * 1.4 assembled this against a local vault (`packages/myco/src/context/cortex-brief.ts`).
 * A dispatched run holds no vault, so the Deployment builds the payload and
 * carries it on the run row as the run's instruction. The material and its
 * limits are 1.4's: five recent sessions with title and summary previews, three
 * spores of each of the three synthesized kinds, three active plans, and an
 * excerpt of the digest at the tier Settings prefers.
 *
 * **This module issues no SQL of its own.** Every read goes through the read
 * layer and the core stores that already own these tables, so a scope rule or a
 * gate fixed there reaches this payload too.
 *
 * **The hash IS the prompt.** `inputHash` is taken over the composed instruction
 * itself, so anything that changes what the model is asked — the material, the
 * leaves, the capability, the served tool surface, the guidance lines, the
 * authoring requirements — moves it, and nothing else can. Hashing a chosen
 * subset of the inputs instead leaves the static prose outside the hash, and an
 * edit to the authoring requirements then never reaches a Project whose material
 * has not moved. The composition carries no clock and no instant: two builds
 * over the same store compose the same bytes, which is what makes the dedup that
 * keeps a daily run from spending dollars on unchanged material work at all.
 *
 * **The tool surface is the served OPS, not the tool list.** A Deployment
 * answers some ops of a served tool and names the rest as not yet served
 * (`UNSERVED_OPS` in the catalogue), and an artifact teaching one of those would
 * send every agent that reads it at a call that refuses. What the payload
 * renders — the tools it names, the ops it lists under each, and the guidance
 * sentences it carries — is cut to what the Deployment answers, and a tool with
 * no answered op is named nowhere. Narrowing the surface moves the hash, so the
 * next dispatch rebuilds the artifact against it.
 *
 * **Known blind spot:** a body whose first 360 characters are identical hashes
 * the same however its tail moves, so an edit past the preview cut does not
 * trigger a rebuild on its own.
 */
import type { RelationalStore } from './adapters.js';
import { digestForTier, listDigests } from './digests.js';
import { countSpores, listSpores, SPORE_BODY_CHARS, SPORE_FULL_READ_BUDGET, SPORE_PREVIEW_CHARS } from './spores.js';
import { DIGEST_TIERS, type RecallLeaves } from './recall.js';
import type { ProjectCapability } from './settings.js';
import { isServedOp, NO_OP, SERVED_TOOLS, type ServedTool } from './tool-catalogue.js';
import { DIGEST_REPORT_ACTION, RUN_SKIP_ACTION } from './run-postconditions.js';
import { TOOL_DEFINITIONS, type ToolDefinition } from '../mcp/definitions.js';
import { listProjectPlans } from '../read/plans.js';
import { listSessions } from '../read/sessions.js';
import type { ReadScope } from '../read/scope.js';
import { sha256Hex } from '../hash.js';

/** How many settled sessions the payload carries. */
export const RECENT_SESSION_LIMIT = 5;
/** How many spores of each synthesized kind the payload carries. */
export const RECENT_WISDOM_SPORE_LIMIT = 3;
export const RECENT_DECISION_SPORE_LIMIT = 3;
export const RECENT_DISCOVERY_SPORE_LIMIT = 3;
/** How many active plans the payload carries. */
export const RECENT_PLAN_LIMIT = 3;
/** How much of one body a preview carries, cut on a word boundary. */
export const CONTENT_PREVIEW_MAX_CHARS = 360;
/** How much of the preferred digest the payload carries. */
export const DIGEST_EXCERPT_MAX_CHARS = 1800;
/** Indentation of the runtime config block the payload renders. */
const JSON_INDENT = 2;

export const CORTEX_SKILLS_NOTE = 'Project and Myco skills are already registered with the agent separately. Tell the agent to use the `myco` skill as the fuller workflow reference for design decisions, non-obvious debugging, prior-project context, plan work, durable knowledge capture, and delegation; keep the explicit tool guidance as the compact always-on version of that workflow. Do not instruct it to call `myco_skills`.';

/** Tool names 1.4 retired. A preview naming one is rewritten before it reaches the model. */
export const RETIRED_TOOL_NAMES = [
  'canopy_map',
  'myco_context',
  'myco_recall',
  'myco_remember',
  'myco_save_plan',
  'myco_runs',
  'myco_supersede',
  'myco_consolidate',
] as const;

export const RETIRED_TOOLS_NOTE = 'Do not mention retired tool names, even as gotchas or historical context. If recent vault context mentions an obsolete name, translate it to the current owning tool from the tool guidance instead.';

const RETIRED_TOOL_PLACEHOLDER = '[retired Myco tool]';
const RETIRED_TOOL_REFERENCE_PATTERN = new RegExp(
  RETIRED_TOOL_NAMES.map((tool) => tool.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'g',
);

export interface InstructionsCounts extends Readonly<Record<string, number>> {
  sessions: number;
  spores: number;
  plans: number;
}

/** A body cut to `maxChars` on a word boundary, with retired tool names rewritten. */
export function preview(text: string | null, maxChars: number = CONTENT_PREVIEW_MAX_CHARS): string | null {
  if (text === null || text === '') return null;
  const sanitized = text
    .replace(RETIRED_TOOL_REFERENCE_PATTERN, RETIRED_TOOL_PLACEHOLDER)
    .replace(/\[retired Myco tool\]\(\)/g, RETIRED_TOOL_PLACEHOLDER);
  if (sanitized.length <= maxChars) return sanitized;
  const cut = sanitized.slice(0, maxChars);
  const boundary = sanitized[maxChars] === ' ' ? maxChars : cut.lastIndexOf(' ');
  return `${(boundary > maxChars / 2 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

/** The ops one definition declares, in its own order; `NO_OP` for a tool that declares none. */
function declaredOps(tool: ToolDefinition): string[] {
  const declared = tool.inputSchema.properties.op?.enum;
  return declared === undefined ? [NO_OP] : declared.filter((value): value is string => typeof value === 'string');
}

/** Every tool this Deployment answers at least one op of, in definition order, each with the ops it answers and no op key for a tool that declares none. */
function servedSurface(): Array<{ name: ServedTool; ops: string[] }> {
  return TOOL_DEFINITIONS
    .filter((tool) => (SERVED_TOOLS as readonly string[]).includes(tool.name))
    .map((tool) => ({ name: tool.name, answered: declaredOps(tool).filter((op) => isServedOp(tool.name, op)) }))
    .filter((tool) => tool.answered.length > 0)
    .map((tool) => ({ name: tool.name, ops: tool.answered.filter((op) => op !== NO_OP) }));
}

/** An `op: "name"` mention, as the guidance writes one. */
const OP_MENTION = /\bop:\s*"([a-z_]+)"/g;

/** Every op a fragment of guidance names. */
function opsNamed(text: string): string[] {
  return [...text.matchAll(OP_MENTION)].map((match) => match[1]!);
}

/** A clause promoted to the front of its sentence: the conjunction that joined it goes, and the opening verb of the clause it replaces comes with it. */
function reopen(dropped: string, rebuilt: string): string {
  const body = rebuilt.replace(/^(?:and|or)\s+/i, '');
  const opener = /^(?:Use|Call|Pass|Prefer)\b/.exec(dropped)?.[0];
  return opener === undefined || body.startsWith(opener)
    ? `${body.charAt(0).toUpperCase()}${body.slice(1)}`
    : `${opener} ${body}`;
}

/**
 * One tool's guidance, cut to the ops this Deployment answers.
 *
 * The guidance is written as sentences whose clauses each teach one op, so a
 * clause naming an op the Deployment does not answer is dropped and the rest of
 * the sentence stands, closed. A sentence that keeps nothing goes whole, and a
 * tool left with no sentence at all carries no guidance line — its ops are still
 * named in the tool surface above. The last cut is on the finished line: anything
 * still naming an unanswered op is dropped rather than sent.
 */
function guidanceForServedOps(guidance: string, served: readonly string[]): string | null {
  const answered = (text: string) => opsNamed(text).every((op) => served.includes(op));
  const kept: string[] = [];
  for (const sentence of guidance.split(/(?<=\.)\s+/)) {
    if (answered(sentence)) { kept.push(sentence); continue; }
    const clauses = sentence.split(/,\s+/);
    const keeping = clauses.filter(answered);
    if (keeping.length === 0) continue;
    const rebuilt = keeping.join(', ');
    const rewritten = keeping[0] === clauses[0] ? rebuilt : reopen(clauses[0]!, rebuilt);
    kept.push(/[.!?]$/.test(rewritten) ? rewritten : `${rewritten}.`);
  }
  const line = kept.join(' ');
  return line === '' || !answered(line) ? null : line;
}

/** How many settled sessions one page of a run's session list carries by default. */
export const RUN_SESSIONS_DEFAULT_LIMIT = 5;
/** The largest page of sessions any run is handed. */
export const RUN_SESSIONS_MAX_LIMIT = 50;
/** How much of a session's summary one row of that page carries. */
export const RUN_SESSION_SUMMARY_CHARS = 360;
/** How much of a session's title one row of that page carries. */
export const RUN_SESSION_TITLE_CHARS = 80;
/** How much of a session's label one row of that page carries. */
export const RUN_SESSION_LABEL_CHARS = 80;

/**
 * The material window each digest tier is written inside, in estimated tokens.
 *
 * Carried from 1.4 (`packages/myco/src/constants.ts` `DIGEST_TIER_MIN_CONTEXT`),
 * where they name the smallest context window a tier's synthesis may run in.
 * The material bound is DERIVED from them rather than equal to them: a window
 * holds the run's whole conversation, and what a `digest-only` run's read
 * window (`core/read-window.ts`) hands it is sized so one reading of the
 * material fits inside it.
 */
export const DIGEST_TIER_MIN_CONTEXT_TOKENS: Readonly<Record<number, number>> = {
  1500: 6_500,
  5000: 18_500,
  10000: 30_500,
};

/** Characters of material to one estimated token. */
export const CHARS_PER_TOKEN = 4;

/**
 * The tier whose window the material routes apply to a digest run.
 *
 * A hosted run reads the material once and writes every tier from that one
 * reading, so what it reads has to fit the smallest window as well as the
 * largest.
 */
export const DIGEST_MATERIAL_TIER = 1500;

/**
 * What a row's ids and instants add beyond the text the routes cut.
 *
 * The only estimate in the sizing: a spore id, a session id, an observation
 * type, an importance and two instants are short by construction but bounded by
 * nothing this module can name. Every other part of a row is cut to a constant
 * beside it, so the estimate covers the keys alone.
 */
export const MATERIAL_ROW_KEYS_ESTIMATE_CHARS = 80;

/** What one session row of the material carries besides its summary: a cut title, a cut label, and its keys. */
export const SESSION_ROW_OVERHEAD_CHARS = RUN_SESSION_TITLE_CHARS + RUN_SESSION_LABEL_CHARS + MATERIAL_ROW_KEYS_ESTIMATE_CHARS;
/** What one spore row of the material carries besides its preview: its keys. */
export const SPORE_ROW_OVERHEAD_CHARS = MATERIAL_ROW_KEYS_ESTIMATE_CHARS;

/** How many rows of `previewChars` of text plus `overheadChars` of everything else fit inside `tier`'s window. */
export function materialRowsForTier(tier: number, previewChars: number, overheadChars: number): number {
  const tokens = DIGEST_TIER_MIN_CONTEXT_TOKENS[tier] ?? DIGEST_TIER_MIN_CONTEXT_TOKENS[DIGEST_MATERIAL_TIER]!;
  return Math.max(1, Math.floor((tokens * CHARS_PER_TOKEN) / (previewChars + overheadChars)));
}

/** How many spore previews one inventory page hands a digest run. */
export const DIGEST_SPORE_PAGE_LIMIT = materialRowsForTier(DIGEST_MATERIAL_TIER, SPORE_PREVIEW_CHARS, SPORE_ROW_OVERHEAD_CHARS);

/**
 * The largest body one of a digest run's full reads carries.
 *
 * The page ceilings are derived from the tier window, and the full reads spend
 * against the same window: a dozen bodies at the sweep's own bound would carry
 * more text than every preview the page ceiling allows. A digest run's share of
 * the window is split across its budgeted reads, and the sweep keeps its own
 * bound.
 */
export const DIGEST_FULL_READ_BODY_CHARS = Math.min(
  SPORE_BODY_CHARS,
  Math.floor((DIGEST_TIER_MIN_CONTEXT_TOKENS[DIGEST_MATERIAL_TIER]! * CHARS_PER_TOKEN) / SPORE_FULL_READ_BUDGET),
);
/** How many session rows one page hands a digest run. */
export const DIGEST_SESSION_PAGE_LIMIT = materialRowsForTier(DIGEST_MATERIAL_TIER, RUN_SESSION_SUMMARY_CHARS, SESSION_ROW_OVERHEAD_CHARS);

/** What the run is told when the owner asks for the digest to be written from the material alone. */
export const DIGEST_FRESH_DIRECTION = 'Ignore the existing digest; write every tier from the material alone.';

export interface DigestCounts extends Readonly<Record<string, number | boolean>> {
  spores: number;
  /** Sessions that ended after the newest digest's own instant, as far as the window reaches. */
  sessionsInWindow: number;
  /** The session page filled, so `sessionsInWindow` is the window's count rather than the Project's. */
  windowFull: boolean;
}

/** What one digest build answers: the prompt the run receives, the hash of its material, and what that material counted. */
export interface DigestInput {
  instruction: string;
  inputHash: string;
  counts: DigestCounts;
}

/** What the digest build is told beyond the store: the Deployment's recall leaves, whether to start over, and the instant it runs at. */
export interface DigestInputOptions {
  leaves: RecallLeaves;
  /** The run writes every tier from the material alone rather than carrying the current digest forward. */
  fresh: boolean;
  now: number;
}

/** The material one digest build read: what the Project already holds, and how much new material stands behind this pass. */
interface DigestMaterial {
  tiers: Array<{ tier: number; generatedAt: number; size: number }>;
  spores: number;
  sessionsInWindow: number;
  /** The session page filled, so the count is the window's rather than the Project's. */
  windowFull: boolean;
}

const EMPTY_DIGEST_TIERS = 'No digest has been written yet — every tier is a first draft.';

function renderTiers(material: DigestMaterial): string {
  if (material.tiers.length === 0) return EMPTY_DIGEST_TIERS;
  return material.tiers
    .map((row) => `- Tier ${row.tier}: ${row.size} characters, generated ${new Date(row.generatedAt).toISOString()}`)
    .join('\n');
}

function renderMaterialCounts(material: DigestMaterial): string {
  const sessions = material.windowFull ? `${material.sessionsInWindow} or more` : String(material.sessionsInWindow);
  return [
    `- Active spores: ${material.spores}`,
    `- Sessions that ended since the newest digest: ${sessions}`,
  ].join('\n');
}

function renderWindows(): string {
  return DIGEST_TIERS
    .map((tier) => `- Tier ${tier}: ${DIGEST_TIER_MIN_CONTEXT_TOKENS[tier]} estimated tokens of material.`)
    .join('\n');
}

/** Everything the digest payload reads, through the stores that own it. */
async function readDigestMaterial(db: RelationalStore, scope: ReadScope): Promise<DigestMaterial> {
  const digests = await listDigests(db, scope);
  const newest = digests.reduce<number | null>((held, row) => (held === null || row.generatedAt > held ? row.generatedAt : held), null);
  const [spores, sessions] = await Promise.all([
    countSpores(db, scope, { status: 'active', includeActive: false }),
    listSessions(db, scope, { limit: DIGEST_SESSION_PAGE_LIMIT, state: 'ended', ...(newest === null ? {} : { since: newest }) }),
  ]);
  return {
    tiers: [...digests].sort((left, right) => left.tier - right.tier).map((row) => ({ tier: row.tier, generatedAt: row.generatedAt, size: row.content.length })),
    spores,
    sessionsInWindow: sessions.rows.length,
    windowFull: sessions.rows.length >= DIGEST_SESSION_PAGE_LIMIT,
  };
}

/**
 * Build the instruction a `digest-only` run receives, and its hash.
 *
 * The digest has no dedup gate. Instructions are one artifact whose material
 * either moved or did not, so an unmoved build is answered without a run; a
 * digest is three tiers a run judges one at a time, and the run itself says
 * through its report which tiers it left alone. The hash is still built — it is
 * filed on every extract the run writes as the substrate hash, naming the
 * material behind each tier — but nothing compares it.
 *
 * **The hash IS the prompt, minus the direction the owner gave.** It is taken
 * over the composed body, and the from-scratch line is composed after it. The
 * direction says how to treat what the Project holds, not what the Project
 * holds, so two runs over one material file their extracts under one substrate
 * hash whether or not one of them is told to start over. Nothing in the body
 * carries a clock.
 */
export async function buildDigestInput(
  db: RelationalStore,
  scope: ReadScope,
  options: DigestInputOptions,
): Promise<DigestInput> {
  const material = await readDigestMaterial(db, scope);
  const parts = [
    'Regenerate this project\'s digest extracts at every token tier from the project\'s current knowledge.',
    `Tier ${options.leaves.digestTier} is the size an owner reads on the dashboard, so that tier carries the most weight.`,
    '',
    '## Current digest',
    renderTiers(material),
    '',
    '## Material behind this pass',
    renderMaterialCounts(material),
    '',
    '## Material windows per tier',
    renderWindows(),
    `One page of \`myco_run_spores\` op "list" carries at most ${DIGEST_SPORE_PAGE_LIMIT} previews; page with \`offset\` for the rest. \`myco_run_sessions\` op "list" answers at most ${DIGEST_SESSION_PAGE_LIMIT} sessions.`,
    `This run gets up to ${SPORE_FULL_READ_BUDGET} full reads with \`myco_run_spores\` op "get", each bounded to ${DIGEST_FULL_READ_BODY_CHARS} characters; judge the rest by their previews.`,
    `Close with \`myco_run\` op "report": action "${DIGEST_REPORT_ACTION}" after writing, or action "${RUN_SKIP_ACTION}" when every tier was left as it stood.`,
  ];

  const body = parts.join('\n');
  return {
    instruction: options.fresh ? `${body}\n\n## From scratch\n${DIGEST_FRESH_DIRECTION}` : body,
    inputHash: await sha256Hex(body),
    counts: { spores: material.spores, sessionsInWindow: material.sessionsInWindow, windowFull: material.windowFull },
  };
}
