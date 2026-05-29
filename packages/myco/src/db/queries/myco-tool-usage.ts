/**
 * Per-session Myco tool-call aggregation.
 *
 * Computes per-session counts of every Myco tool call from the persisted
 * `activities` rows. Run at each Stop boundary; the result is materialized
 * into `session_myco_tool_calls` by `materializeSessionMycoToolCalls`.
 *
 * Mirrors the pattern in `db/queries/canopy.ts`: a derived view over the
 * authoritative activity log, no in-memory state, no dispatch-time counters.
 *
 * Two routing shapes land Myco tool calls in `activities`, and both roll up
 * here:
 *   - MCP / HTTP / agent-internal → the activity's `tool_name` IS the Myco
 *     tool (e.g. `mcp__myco__myco_cortex`). Matched + canonicalized in SQL.
 *   - CLI (`node .agents/myco-cli.cjs tool call <tool> --input '{"op":…}'`,
 *     the path the myco skill instructs agents to use) → the activity is the
 *     agent's shell tool (`Bash` / `shell` / …) and the Myco call is embedded
 *     in the command string. The hook still attributes that shell activity to
 *     the session, so a parse pass over shell commands (`parseCliMycoToolCalls`)
 *     recovers those calls. Without it, every CLI-routed call — including the
 *     canopy_map calls behind the Sessions "Map calls" tile — was uncounted.
 *
 * The two sources are disjoint (shell rows never match the `mcp__myco__` /
 * `myco_` name patterns), so merging their counts cannot double-count a call.
 *
 * Tool-name canonicalization rules applied in SQL:
 *   - `mcp__myco__myco_myco_<tool>` → `myco_<tool>`  (combined legacy artifact)
 *   - `mcp__myco__<tool>`           → `<tool>`        (MCP-routed names)
 *   - `myco_myco_<tool>`            → `myco_<tool>`   (legacy: pre-fix daemon
 *                                                     applied the `myco_`
 *                                                     prefix twice in
 *                                                     activity rows. Confirmed
 *                                                     in the dogfood vault;
 *                                                     no tool in
 *                                                     `TOOL_DEFINITIONS` is
 *                                                     actually named
 *                                                     `myco_myco_*`.)
 *
 * `op` is `COALESCE(json_extract(tool_input,'$.op'), '')`; empty string
 * (not NULL) is used so the composite PRIMARY KEY on
 * `(session_id, tool_name, op)` is stable for tools with no op dimension.
 *
 * Rows whose `tool_input` is not valid JSON are skipped via `json_valid` so
 * a single malformed payload cannot abort the GROUP BY.
 */

import type { Database } from 'bun:sqlite';
import { getDatabase } from '@myco/db/client.js';
import { MYCO_TOOL_LIKE_PATTERNS } from '@myco/db/queries/team-outbox.js';

// ---------------------------------------------------------------------------
// Myco tool-name structure (single source of truth)
//
// The prefix/family tokens that recognize and canonicalize Myco tool names.
// Centralized so the SQL aggregate CASE and the JS resolver can never drift on
// a literal, and so a convention change is a one-line edit instead of a
// find-and-replace across string-matching call sites.
// ---------------------------------------------------------------------------
/** MCP-routed names arrive prefixed, e.g. `mcp__myco__myco_search`. */
const MCP_TOOL_PREFIX = 'mcp__myco__';
/** Legacy artifact: a pre-fix daemon double-applied the family prefix. */
const LEGACY_DOUBLED_PREFIX = 'myco_myco_';
const MYCO_TOOL_FAMILY = 'myco_';
const COLLECTIVE_TOOL_FAMILY = 'collective_';
/** A canonical Myco tool name starts with one of these. */
const MYCO_TOOL_FAMILIES = [MYCO_TOOL_FAMILY, COLLECTIVE_TOOL_FAMILY] as const;
/** The op dimension's JSON key + json_extract path on a tool_input payload. */
const TOOL_OP_KEY = 'op';
const TOOL_OP_JSON_PATH = `$.${TOOL_OP_KEY}`;

export interface MycoToolCallAggregateRow {
  tool_name: string;
  op: string;
  count: number;
}

/**
 * Aggregation SQL. Selects the per-(tool, op) count for one session,
 * canonicalizing tool names (see module doc) and skipping malformed JSON.
 *
 * Tool-name allowlist is encoded inline as four LIKE patterns rather than
 * passed as a parameter list — the four patterns deliberately match the
 * shape of all current and historical Myco / Collective tool names without
 * needing TOOL_DEFINITIONS at the query layer. Adding a new tool that
 * follows the `myco_*` or `collective_*` convention surfaces here for free.
 *
 * Implementation note: the canonicalization runs inside a CTE, and the
 * outer GROUP BY references the CTE columns. SQLite resolves a bare
 * `GROUP BY tool_name` against the source table column when the alias
 * collides with one, which would put `mcp__myco__myco_cortex` and the
 * canonicalized `myco_cortex` into separate buckets even though the SELECT
 * shows the same label for both. The CTE avoids that resolution shadow.
 */
/** WHERE-clause fragment built from the shared `MYCO_TOOL_LIKE_PATTERNS`. */
const MYCO_TOOL_WHERE_ALLOWLIST = MYCO_TOOL_LIKE_PATTERNS
  .map((p) => `a.tool_name LIKE '${p}' ESCAPE '\\'`)
  .join('\n      OR ');

/** Tool-name canonicalization CASE (see module doc), built from the shared
 *  prefix constants so it stays in lockstep with `canonicalizeMycoToolName`.
 *  SQLite substr() is 1-indexed, so each offset is stripped-length + 1. */
const CANONICAL_TOOL_NAME_CASE = `
    CASE
      WHEN a.tool_name LIKE '${MCP_TOOL_PREFIX}${LEGACY_DOUBLED_PREFIX}%' THEN substr(a.tool_name, ${MCP_TOOL_PREFIX.length + MYCO_TOOL_FAMILY.length + 1})
      WHEN a.tool_name LIKE '${MCP_TOOL_PREFIX}%'                          THEN substr(a.tool_name, ${MCP_TOOL_PREFIX.length + 1})
      WHEN a.tool_name LIKE '${LEGACY_DOUBLED_PREFIX}%'                    THEN substr(a.tool_name, ${MYCO_TOOL_FAMILY.length + 1})
      ELSE a.tool_name
    END`;

const AGGREGATE_SQL = `
WITH normalized AS (
  SELECT
    ${CANONICAL_TOOL_NAME_CASE} AS canonical_tool_name,
    COALESCE(json_extract(a.tool_input, '${TOOL_OP_JSON_PATH}'), '') AS canonical_op
  FROM activities a
  WHERE a.session_id = ?
    AND (
      ${MYCO_TOOL_WHERE_ALLOWLIST}
    )
    AND (a.tool_input IS NULL OR json_valid(a.tool_input))
)
SELECT
  canonical_tool_name AS tool_name,
  canonical_op        AS op,
  COUNT(*)            AS count
FROM normalized
GROUP BY canonical_tool_name, canonical_op
`;

/**
 * JS twin of {@link CANONICAL_TOOL_NAME_CASE}: collapse an MCP-prefixed or
 * legacy-doubled Myco tool name to its canonical `myco_*` / `collective_*`
 * form. Returns null when `name` is not a Myco tool name at all (e.g. `Bash`),
 * which is how the capture-time resolver distinguishes a direct Myco tool call
 * from a shell tool that merely *wraps* a CLI Myco call.
 */
function canonicalizeMycoToolName(name: string): string | null {
  let n = name;
  if (n.startsWith(MCP_TOOL_PREFIX + LEGACY_DOUBLED_PREFIX)) n = n.slice(MCP_TOOL_PREFIX.length + MYCO_TOOL_FAMILY.length);
  else if (n.startsWith(MCP_TOOL_PREFIX)) n = n.slice(MCP_TOOL_PREFIX.length);
  else if (n.startsWith(LEGACY_DOUBLED_PREFIX)) n = n.slice(MYCO_TOOL_FAMILY.length);
  return MYCO_TOOL_FAMILIES.some((family) => n.startsWith(family)) ? n : null;
}

/**
 * Resolve the canonical Myco tool identity (tool + op) a raw activity
 * represents, regardless of entry point — the single source of truth materialized
 * onto `activities.myco_tool` / `myco_op` at the capture write boundary.
 *
 *   - MCP / HTTP / agent-internal → the activity's own (canonicalized) tool name.
 *   - CLI (`… tool call <tool> --input '{"op":…}'`) → the FIRST Myco call parsed
 *     from the shell command (see {@link parseCliMycoToolCalls}). A single shell
 *     command can chain several Myco calls (~3% of CLI rows); the activity row
 *     carries the primary one for display, while the per-session count aggregate
 *     ({@link aggregateSessionMycoToolCalls}) still parses the full command so
 *     the "Map calls" metric stays exact.
 *
 * Returns null for non-Myco activities (plain Bash, Read, …) and for malformed
 * `tool_input`.
 */
export function resolveMycoToolIdentity(
  toolName: string | null | undefined,
  toolInput: string | null | undefined,
): { tool: string; op: string } | null {
  if (!toolName) return null;

  // 1) Direct Myco tool name (MCP-routed or bare).
  const canonical = canonicalizeMycoToolName(toolName);
  if (canonical) {
    let op = '';
    if (toolInput) {
      try {
        op = String((JSON.parse(toolInput) as Record<string, unknown>)?.[TOOL_OP_KEY] ?? '');
      } catch { /* op stays '' */ }
    }
    return { tool: canonical, op };
  }

  // 2) Shell tool wrapping a CLI Myco call — recover identity from the command.
  if (toolInput) {
    let command: unknown;
    try { command = (JSON.parse(toolInput) as { command?: unknown })?.command; } catch { return null; }
    if (typeof command === 'string') {
      const calls = parseCliMycoToolCalls(command);
      if (calls.length > 0) return { tool: calls[0]!.tool_name, op: calls[0]!.op };
    }
  }
  return null;
}

/**
 * Recognizes Myco tool calls routed through the CLI rather than MCP.
 *
 * The myco skill instructs agents to call tools via the project launcher —
 * `node .agents/myco-cli.cjs tool call <tool> --input '{"op":"…"}'` (also
 * `myco-run`, `dist/src/cli.js`, or a bare `myco` / `myco-dev` on PATH). Those
 * execute as the agent's shell tool (`Bash` / `shell` / …), so the PostToolUse
 * hook records them under the shell tool's name, not the Myco tool's. The
 * SQL aggregate above keys on `mcp__myco__*` / `myco_*` activity names and
 * therefore never sees them — every CLI-routed call (including canopy_map,
 * which drives the Sessions "Map calls" tile) was silently uncounted.
 *
 * This parser closes that gap at the derived-view layer — consistent with the
 * module's "pure view over the authoritative activity log" design. Attribution
 * is already correct: the shell activity carries the session_id the hook
 * stamped. We require a launcher token immediately before `tool call <name>`
 * and constrain `<name>` to the `myco_` / `collective_` families so prose or
 * unrelated commands containing "tool call" can't false-match.
 */
/** Capture group matching a canonical Myco tool name, built from the families. */
const MYCO_TOOL_NAME_GROUP = MYCO_TOOL_FAMILIES.map((family) => `${family}[a-z_]+`).join('|');
const CLI_TOOL_CALL_RE = new RegExp(
  String.raw`(?:myco-cli\.cjs|myco-run(?:\.cjs)?|cli\.js|\bmyco(?:-dev)?)\s+tool\s+call\s+(${MYCO_TOOL_NAME_GROUP})`,
  'g',
);
/** Inline `--input '{"op":"…"}'` op extractor (keyed on the shared op key). */
const CLI_OP_RE = new RegExp(String.raw`"${TOOL_OP_KEY}"\s*:\s*"([^"]+)"`);
/** Shell separators that bound a single command segment (newline, `;`, `|`, `&`). */
const SHELL_SEPARATOR_RE = /[\n;|&]/;

/** Parse zero or more CLI-routed Myco tool calls out of one shell command. */
export function parseCliMycoToolCalls(command: string): Array<{ tool_name: string; op: string }> {
  const out: Array<{ tool_name: string; op: string }> = [];
  const matches = [...command.matchAll(CLI_TOOL_CALL_RE)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const tool_name = m[1]!;
    // Scan from just after the tool name to the start of the next CLI call (or
    // end of command) for an inline `--input '{"op":"…"}'`. `--input @file`
    // and op-less calls resolve to '' — the same empty-op key the SQL path uses.
    const segStart = m.index! + m[0].length;
    let segEnd = i + 1 < matches.length ? matches[i + 1]!.index! : command.length;
    // Bound the op scan to THIS call's own command segment. Without this, an
    // op-less call (e.g. `--input @file`) followed by an unrelated command,
    // argument, or piped stage containing an `"op":"…"` JSON fragment would
    // mis-attribute that op to the call — most acutely the LAST call, whose
    // segment otherwise runs to the end of the whole command. Cut at the first
    // shell separator (newline, `;`, `|`, `&`) after the tool name; this call's
    // inline `--input '{"op":…}'` carries op before any such separator.
    const sepMatch = SHELL_SEPARATOR_RE.exec(command.slice(segStart, segEnd));
    if (sepMatch) segEnd = segStart + sepMatch.index;
    const opMatch = CLI_OP_RE.exec(command.slice(segStart, segEnd));
    out.push({ tool_name, op: opMatch ? opMatch[1]! : '' });
  }
  return out;
}

/**
 * Compute the per-session Myco tool-call aggregate from persisted activity
 * rows. Pure SQL for MCP-named calls, plus a parse pass over shell activities
 * for CLI-routed calls. No in-memory state. Safe to call repeatedly.
 *
 * Returns an empty array when the session has no Myco tool calls.
 */
export function aggregateSessionMycoToolCalls(
  db: Database | null,
  sessionId: string,
): MycoToolCallAggregateRow[] {
  const handle = db ?? getDatabase();
  const counts = new Map<string, { tool_name: string; op: string; count: number }>();
  const bump = (tool_name: string, op: string, by: number) => {
    const key = `${tool_name} ${op}`;
    const existing = counts.get(key);
    if (existing) existing.count += by;
    else counts.set(key, { tool_name, op, count: by });
  };

  const rows = handle.prepare(AGGREGATE_SQL).all(sessionId) as Array<{
    tool_name: string;
    op: string;
    count: number | null;
  }>;
  for (const row of rows) bump(row.tool_name, row.op, Number(row.count ?? 0));

  // CLI-routed calls: scan shell activities whose command embeds a launcher
  // `tool call <name>`. Narrowed by the LIKE so we don't deserialize every
  // activity row; the regex in parseCliMycoToolCalls is the precise filter.
  const cliRows = handle
    .prepare(
      `SELECT tool_input FROM activities
        WHERE session_id = ?
          AND tool_input LIKE '%tool call %'
          AND (tool_input IS NULL OR json_valid(tool_input))`,
    )
    .all(sessionId) as Array<{ tool_input: string | null }>;
  for (const { tool_input } of cliRows) {
    if (!tool_input) continue;
    let command: unknown;
    try {
      command = JSON.parse(tool_input)?.command;
    } catch {
      continue;
    }
    if (typeof command !== 'string') continue;
    for (const call of parseCliMycoToolCalls(command)) {
      bump(call.tool_name, call.op, 1);
    }
  }

  return [...counts.values()];
}

/**
 * Compute the aggregate and UPSERT it into `session_myco_tool_calls`.
 *
 * Idempotent: re-running produces the same final table state. Old rows
 * for tools the session no longer reports are deleted so the materialized
 * view is a faithful snapshot — never a stale superset — of the
 * activities truth.
 *
 * Resolves the owning session's `project_id` once and stamps it onto every
 * row so per-project queries (`WHERE project_id = ?`) work without a JOIN.
 *
 * Returns the number of rows now stored for the session, or `null` if the
 * underlying query failed. Internal failures are swallowed so this is
 * safe to call fire-and-forget from the Stop pipeline.
 */
export function materializeSessionMycoToolCalls(
  sessionId: string,
  db?: Database | null,
): number | null {
  const handle = db ?? getDatabase();
  let aggregate: MycoToolCallAggregateRow[];
  let projectId: string | null;
  try {
    const sessionRow = handle
      .prepare('SELECT project_id FROM sessions WHERE id = ?')
      .get(sessionId) as { project_id: string | null } | undefined;
    if (!sessionRow) return null;
    projectId = sessionRow.project_id ?? null;
    aggregate = aggregateSessionMycoToolCalls(handle, sessionId);
  } catch {
    return null;
  }

  // Single transaction: delete the previous snapshot for this session, then
  // insert the new one. Two-step keeps the deletion bounded to this session
  // (rather than relying on INSERT-or-replace, which leaves orphan rows when
  // a tool stops being called between snapshots).
  try {
    const tx = handle.transaction((rows: MycoToolCallAggregateRow[]) => {
      handle
        .prepare('DELETE FROM session_myco_tool_calls WHERE session_id = ?')
        .run(sessionId);
      if (rows.length === 0) return;
      const insert = handle.prepare(
        `INSERT INTO session_myco_tool_calls
           (session_id, project_id, tool_name, op, count, computed_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())`,
      );
      for (const row of rows) {
        insert.run(sessionId, projectId, row.tool_name, row.op, row.count);
      }
    });
    tx(aggregate);
  } catch {
    return null;
  }

  return aggregate.length;
}

/**
 * Read-side helper for UI / API consumers — returns the materialized
 * per-(tool, op) counts for one session, ordered by descending count.
 *
 * This is what the session-detail page should query for the "Map calls"
 * metric and any future per-Myco-tool tiles.
 */
export function getSessionMycoToolCallCounts(
  sessionId: string,
  db?: Database | null,
): MycoToolCallAggregateRow[] {
  const handle = db ?? getDatabase();
  const rows = handle
    .prepare(
      `SELECT tool_name, op, count
         FROM session_myco_tool_calls
        WHERE session_id = ?
        ORDER BY count DESC, tool_name ASC, op ASC`,
    )
    .all(sessionId) as Array<{ tool_name: string; op: string; count: number | null }>;
  return rows.map((row) => ({
    tool_name: row.tool_name,
    op: row.op,
    count: Number(row.count ?? 0),
  }));
}
