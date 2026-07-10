/**
 * OKF synthesis harness tools.
 *
 * 8 tools driving the `okf-synthesize` task's explore → plan → map-synthesize
 * pipeline over the DB-resident wiki:
 *   - okf_read_sources     — bounded, citable source ORIENTATION.
 *   - okf_read_spec        — fetch the authoritative OKF v0.1 spec (format authority).
 *   - okf_list_pages       — current wiki pages (row heads).
 *   - okf_read_page        — one page's current content (head + latest revision).
 *   - okf_write_plan       — create the DRAFT wiki generation carrying the plan.
 *   - okf_list_planned_pages — the map-phase SOURCE: reads the draft's plan back.
 *   - okf_write_page       — the map-phase SINK: head upsert + revision row.
 *   - okf_report           — pure observability report.
 *
 * THE PLAN→MAP HANDOFF: a map-phase source tool is called by harness code with
 * only `{params}` — it cannot receive a prior phase's in-memory output. The
 * `WikiPlan` reaches the `synthesize` map phase ONLY because `okf_write_plan`
 * persists it on the draft `okf_generations` row and `okf_list_planned_pages`
 * reads it back (the `canopy_describe_next` persisted-state pattern).
 *
 * All wiki writes go through `OkfStore` — this module never writes okf_* rows
 * directly, mirroring the constrained `myco_okf` MCP surface
 * (packages/myco/src/tools/okf.ts). Nothing here touches the filesystem: disk
 * materialization of the wiki is the user-driven claim flow's concern.
 */

import path from 'node:path';
import { z } from 'zod/v4';
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { epochSeconds } from '@myco/constants.js';
import { loadMergedConfig } from '@myco/config/loader.js';
import { projectTreeAvailable } from '@myco/vault/resolve.js';
import { OkfError } from '@myco/okf/errors.js';
import { OkfStore } from '@myco/okf/store.js';
import { gatherSources, gatherCanopyMap } from '@myco/okf/synthesis/sources.js';
import { validateWikiPlan, type WikiPlan } from '@myco/okf/synthesis/plan.js';
import { renderOkfDocument } from '@myco/okf/serialize.js';
import type { OkfDocument } from '@myco/okf/types.js';
import { insertReport } from '@myco/db/queries/reports.js';
import { listOkfPages, listRevisionsForGeneration } from '@myco/db/queries/okf.js';
import { OKF_REPORT_ACTION } from '../instruction-builders.js';
import { OKF_TOOL_NAMES } from '../tool-names.js';
import {
  textResult,
  projectScopeFromVaultToolDeps,
  rowProjectIdFromVaultToolDeps,
  type VaultToolDeps,
} from './types.js';

export { OKF_TOOL_NAMES };

// ---------------------------------------------------------------------------
// Shared dependency construction
// ---------------------------------------------------------------------------

/**
 * Build the `OkfStore` this factory's tools share, or `null` when the
 * deps required to construct one are absent. `VaultToolDeps` makes
 * `projectRoot`/`vaultDir`/`requestContext` all optional (harness tools are
 * also used outside a Grove-bound run) — every tool below fails closed
 * with a tool-error result rather than guessing a project identity.
 */
function buildStore(deps: VaultToolDeps): OkfStore | null {
  if (!deps.vaultDir || !deps.requestContext) return null;
  // Host-run tasks for a served project have no local working tree —
  // degrade to machine+grove tiers (empty project tier); the store is
  // DB-resident.
  const config = loadMergedConfig(deps.vaultDir, {
    groveId: deps.requestContext.groveId ?? undefined,
    projectTierOptional: !projectTreeAvailable(deps.vaultDir),
  });
  const projectId = rowProjectIdFromVaultToolDeps(deps);
  if (!projectId) return null;
  return new OkfStore({
    scope: projectScopeFromVaultToolDeps(deps),
    projectId,
    machineId: deps.machineId ?? deps.requestContext.machineId,
    config,
  });
}

const MISSING_DEPS_ERROR = 'okf tools require projectRoot, vaultDir, and requestContext — none available in this run';

/**
 * Explicit instruction returned alongside the orientation (kind: all) so the
 * agent treats `okf_read_sources` as a starting point, not the whole corpus.
 * The bounded orientation only gives the project's shape + citable ids; the
 * agent is expected to EXPLORE the real code and vault with the phase's other
 * read tools before writing a page.
 */
const OKF_SOURCE_GUIDANCE =
  'This is a bounded ORIENTATION, not the full corpus. Use the Canopy map + repo-tree summary to get the project\'s shape, then EXPLORE the real code and vault with this phase\'s tools: fs_tree/fs_list to walk the structure, fs_read to read the actual source of the modules a page covers, code_grep to find code by pattern, vault_search_canopy to find files by what they do, and vault_search_semantic/vault_search_fts for the decisions, gotchas, and rationale behind the code. Ground each page in files you actually read and cite them.';

// ---------------------------------------------------------------------------
// OKF spec fetch (provider-agnostic format authority)
// ---------------------------------------------------------------------------

/**
 * Canonical raw URL for the authoritative OKF v0.1 spec. Fetched server-side by
 * `okf_read_spec` (below) so the synthesis agent grounds its output format in
 * the real spec regardless of which model provider is configured — NO vendored
 * static copy (it would drift from canonical), and NO provider-specific
 * built-in WebFetch (it would break OKF synthesis for non-Claude providers).
 * Human URL: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */
const OKF_SPEC_URL = 'https://raw.githubusercontent.com/GoogleCloudPlatform/knowledge-catalog/main/okf/SPEC.md';
/** Day-scoped in-memory cache so repeated reads in one run (and across nearby runs) don't refetch. */
const OKF_SPEC_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Abort the fetch if the endpoint hangs — the agent must degrade to prompt-encoded essentials, not stall the phase. */
const OKF_SPEC_FETCH_TIMEOUT_MS = 15_000;
/** Guard against an unexpectedly huge response body blowing the tool result. */
const OKF_SPEC_MAX_BYTES = 512_000;

let okfSpecCache: { text: string; fetchedAt: number } | null = null;

/**
 * Clear the module-level OKF spec cache. Test-only — lets a hermetic test drive
 * `okf_read_spec` with a mocked `fetch` without a prior test's cached body
 * bleeding through. Never called in production.
 */
export function __clearOkfSpecCacheForTests(): void {
  okfSpecCache = null;
}

type OkfSpecFetch =
  | { ok: true; spec: string; cached: boolean; url: string }
  | { ok: false; error: string; url: string };

/** Server-side HTTP GET of the canonical OKF spec with a day cache and a hard timeout. Never throws. */
async function fetchOkfSpec(): Promise<OkfSpecFetch> {
  const now = epochSeconds() * 1000;
  if (okfSpecCache && now - okfSpecCache.fetchedAt < OKF_SPEC_CACHE_TTL_MS) {
    return { ok: true, spec: okfSpecCache.text, cached: true, url: OKF_SPEC_URL };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OKF_SPEC_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(OKF_SPEC_URL, { signal: controller.signal, redirect: 'follow' });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status} ${res.statusText}`.trim(), url: OKF_SPEC_URL };
    }
    let text = await res.text();
    if (text.length > OKF_SPEC_MAX_BYTES) {
      text = `${text.slice(0, OKF_SPEC_MAX_BYTES)}\n\n... [OKF spec truncated at ${OKF_SPEC_MAX_BYTES} bytes]`;
    }
    okfSpecCache = { text, fetchedAt: now };
    return { ok: true, spec: text, cached: false, url: OKF_SPEC_URL };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err), url: OKF_SPEC_URL };
  } finally {
    clearTimeout(timer);
  }
}

function okfErrorResult(err: unknown): { content: Array<{ type: 'text'; text: string }> } {
  if (err instanceof OkfError) {
    return textResult({ error: err.message, code: err.code });
  }
  return textResult({ error: err instanceof Error ? err.message : String(err) });
}

function nowIso(): string {
  return new Date(epochSeconds() * 1000).toISOString();
}

/**
 * Collapse any newline/CR/control char to a single space so a frontmatter
 * `title`/`description` stays a single line. This is the PRIMARY sanitizer for
 * the markdown-structure-injection vector: a title or description is later
 * rendered raw into a generated index bullet's `* [title](link) - desc`, where
 * an embedded newline splices a new markdown line. The validator's
 * `unsafe_frontmatter_text` check (validate.ts) is only a publish-time backstop;
 * a `]` in a title is left to that backstop (neutralizing it here would silently
 * alter authored content).
 */
function sanitizeFrontmatterLine(text: string): string {
  // Replace CR/LF/tab and any other C0 control char (and DEL) with a space,
  // then collapse runs of whitespace, so the value stays a single line.
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    out += code < 0x20 || code === 0x7f ? ' ' : ch;
  }
  return out.replace(/\s+/g, ' ').trim();
}


// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createOkfTools(deps: VaultToolDeps) {
  const { runId } = deps;
  const projectId = rowProjectIdFromVaultToolDeps(deps);

  const okfReadSources = tool(
    'okf_read_sources',
    'Read a BOUNDED orientation to this project\'s OKF sources — NOT a full dump: the Canopy map (the structural guide), a top-level repo-tree summary (directories + file counts, plus root files), git diff context, and a capped sample of citable vault refs (spores, decisions, Canopy files) as id+title+type — never full bodies. This is a STARTING POINT: explore the real code and vault from here with fs_tree/fs_list/fs_read, code_grep, vault_search_canopy, and vault_search_semantic/vault_search_fts. Pass kind to fetch one slice: "map" is the cheap per-page choice (just the Canopy map), "repo"/"git"/"vault" are the full slices; omit for all. Read-only.',
    {
      kind: z.enum(['all', 'repo', 'git', 'vault', 'map']).optional().describe('Which source slice to return (default all). "map" returns only the Canopy map — the cheap structural orientation.'),
    },
    async (args) => {
      if (!deps.projectRoot || !deps.vaultDir || !deps.requestContext) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        // Same tree-unavailable degrade as buildStore above. The git slice
        // fails soft on its own (runGit catch); a repo-tree walk of an
        // absent root surfaces as this tool's structured error via the
        // catch below rather than blocking config resolution here.
        const config = loadMergedConfig(deps.vaultDir, {
          groveId: deps.requestContext.groveId ?? undefined,
          projectTierOptional: !projectTreeAvailable(deps.vaultDir),
        });
        const scope = projectScopeFromVaultToolDeps(deps);
        const machineId = deps.machineId ?? deps.requestContext.machineId;
        // A claimed on-disk bundle (e.g. this repo's committed okf/) is still
        // excluded from the repo-tree orientation; content pages must not
        // orient on the wiki they are regenerating.
        const outputRoot = path.resolve(
          deps.projectRoot,
          config.okf?.maintain?.output_path ?? 'okf',
        );
        const sourceScope = {
          projectRoot: deps.projectRoot,
          scope,
          projectId: projectId ?? '',
          machineId,
          config,
          outputRoot,
        };
        if (args.kind === 'map') {
          return textResult({ canopyMap: gatherCanopyMap(sourceScope) });
        }
        const gathered = gatherSources(sourceScope);
        const kind = args.kind ?? 'all';
        const out: Record<string, unknown> = {};
        if (kind === 'all' || kind === 'repo') out.repoTree = gathered.repoTree;
        if (kind === 'all' || kind === 'git') out.gitContext = gathered.gitContext;
        if (kind === 'all' || kind === 'vault') out.vault = gathered.vault;
        if (kind === 'all') out.guidance = OKF_SOURCE_GUIDANCE;
        return textResult(out);
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfReadSpec = tool(
    'okf_read_spec',
    'Fetch and return the authoritative OKF v0.1 specification so you can ground your output format EXACTLY — frontmatter keys/order, per-folder indexes, cross-link form, log, citations. Server-side HTTP GET of the canonical raw URL with a short in-memory cache; a Myco harness tool that works the same for every model provider (no provider-specific built-in). Returns {ok:true, spec} on success, or {ok:false, error} on a fetch failure — in which case fall back to the essential OKF rules in your phase prompt. Read-only.',
    {},
    async () => {
      const result = await fetchOkfSpec();
      if (!result.ok) {
        return textResult({
          ok: false,
          error: `could not fetch OKF spec: ${result.error}`,
          url: result.url,
          guidance: 'Fetch failed — follow the essential OKF v0.1 rules stated in your phase prompt instead.',
        });
      }
      return textResult({ ok: true, url: result.url, cached: result.cached, spec: result.spec });
    },
    { annotations: { readOnlyHint: true, openWorldHint: true } },
  );

  const okfListPages = tool(
    'okf_list_pages',
    'List the current OKF wiki pages (bundle-relative path + type + title) plus the latest published wiki generation. Read-only — never writes.',
    {},
    async () => {
      const store = buildStore(deps);
      if (!store) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        const published = store.latestPublished();
        const pages = listOkfPages(projectScopeFromVaultToolDeps(deps), 'active');
        return textResult({
          bundleExists: pages.length > 0,
          generation: published?.generation ?? null,
          pages: pages.map((p) => ({ path: p.path, type: p.type, title: p.title, description: p.description })),
        });
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfReadPage = tool(
    'okf_read_page',
    'Read one OKF wiki page\'s current content by bundle-relative path (with or without the .md suffix). Returns {page:null} for a missing or unsafe path. Read-only.',
    {
      path: z.string().describe('Bundle-relative page path, e.g. "guides/overview" or "guides/overview.md".'),
    },
    async (args) => {
      const store = buildStore(deps);
      if (!store) return textResult({ error: MISSING_DEPS_ERROR });
      try {
        return textResult({ page: store.readPage(args.path) });
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfWritePlan = tool(
    'okf_write_plan',
    'Persist the wiki page-plan for this synthesis run as the DRAFT wiki generation — the capped, auditable list of pages the run intends to write. Validated (page cap, slug-safe paths, no reserved basenames, non-empty types, unique paths) before persisting; a plan with violations is rejected and nothing is written. Creating the draft supersedes any prior unpublished generation. This is the ONLY way the plan reaches the map-synthesize phase (it reads the draft back through okf_list_planned_pages).',
    {
      pages: z.array(z.object({
        path: z.string().describe('Bundle-relative, OKF-slug-safe page path (no leading slash, no traversal).'),
        type: z.string().describe('Non-empty OKF document type, e.g. "concept", "overview", "glossary".'),
        title: z.string().describe('Page title.'),
        rationale: z.string().describe('Why this page belongs in the wiki (auditable).'),
        sourceRefs: z.array(z.string()).default([]).describe('Stable ids of the source material this page synthesizes from.'),
        openQuestions: z.array(z.string()).optional().describe('Gaps flagged for this page; omit when there are none.'),
      })).describe('The pages to plan (capped; a runaway plan is rejected).'),
      sinceRef: z.string().optional().describe('The git ref this run diffed against; omit for a full-scan run.'),
    },
    async (args) => {
      const store = buildStore(deps);
      if (!store) return textResult({ ok: false, error: MISSING_DEPS_ERROR });
      try {
        const plan: WikiPlan = {
          generatedAt: nowIso(),
          sinceRef: args.sinceRef ?? '',
          pages: args.pages.map((p) => ({
            path: p.path,
            type: p.type,
            title: p.title,
            rationale: p.rationale,
            sourceRefs: p.sourceRefs ?? [],
            ...(p.openQuestions && p.openQuestions.length > 0 ? { openQuestions: p.openQuestions } : {}),
          })),
        };
        // Dry-run validates without creating rows — the store's plan
        // validation is reproduced by validateWikiPlan, the same function it
        // applies internally.
        if (deps.dryRun) {
          const errors = validateWikiPlan(plan);
          if (errors.length > 0) return textResult({ ok: false, errors });
          return textResult({ ok: true, pageCount: plan.pages.length, dryRun: true });
        }
        const draft = store.createDraftGeneration({ runId: runId ?? null, plan });
        return textResult({ ok: true, pageCount: plan.pages.length, generation: draft.generation });
      } catch (err) {
        return okfErrorResult(err);
      }
    },
    { annotations: { idempotentHint: true } },
  );

  const okfListPlannedPages = tool(
    'okf_list_planned_pages',
    'Read back the draft wiki generation\'s page-plan as {pages}. The map-synthesize phase\'s SOURCE tool — returns the pages okf_write_plan persisted, or an empty list when no draft is open. Pages that already carry a revision on this draft (written before an interrupted run resumed) are excluded and listed under {alreadyWritten}. Read-only.',
    {},
    async () => {
      const store = buildStore(deps);
      if (!store) return textResult({ error: MISSING_DEPS_ERROR, pages: [] });
      try {
        const draft = store.currentDraft();
        if (!draft) return textResult({ pages: [] });
        const plan = JSON.parse(draft.plan) as WikiPlan;
        const pages = plan.pages ?? [];
        const written = new Set(
          listRevisionsForGeneration(draft.id).map((rev) => rev.path.replace(/\.md$/, '')),
        );
        if (written.size === 0) return textResult({ pages });
        const remaining = pages.filter((p) => !written.has(p.path.replace(/\.md$/, '')));
        const alreadyWritten = pages.filter((p) => written.has(p.path.replace(/\.md$/, ''))).map((p) => p.path);
        return textResult({ pages: remaining, alreadyWritten });
      } catch (err) {
        return textResult({ error: err instanceof Error ? err.message : String(err), pages: [] });
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const okfWritePage = tool(
    'okf_write_page',
    'Synthesize one OKF page and write it against this run\'s draft wiki generation — a head upsert plus a full-content revision row, in one transaction. The map-synthesize phase\'s SINK — the harness pins path/type/title from the plan; you supply description and body. Identifier sanitization happens at the write; the whole generation publishes (or blocks on findings) once, after the map phase. Returns {ok:true} on write, {ok:false, reason} when the document is rejected (no open draft, reserved filename, unsafe path). Content lives in the database; the repo-visible bundle is materialized later by the user-driven claim flow.',
    {
      path: z.string().describe('Bundle-relative page path (pinned from the plan).'),
      type: z.string().describe('OKF document type (pinned from the plan).'),
      title: z.string().describe('Page title (pinned from the plan).'),
      description: z.string().describe('One-line page description for the OKF frontmatter.'),
      body: z.string().describe('Full page markdown body (no frontmatter).'),
      tags: z.array(z.string()).optional().describe('Optional OKF tags.'),
    },
    async (args) => {
      const store = buildStore(deps);
      if (!store) return textResult({ ok: false, reason: MISSING_DEPS_ERROR });
      try {
        const docPath = args.path.endsWith('.md') ? args.path : `${args.path}.md`;
        // Dry-run: validate the render (throws on an invalid path/reserved
        // name) without writing rows. A dry-run run never reaches
        // finalizeOkfSynthesize, so nothing is published either way.
        if (deps.dryRun) {
          const previewDoc: OkfDocument = {
            path: docPath,
            frontmatter: {
              type: args.type.trim() || 'note',
              title: sanitizeFrontmatterLine(args.title),
              description: sanitizeFrontmatterLine(args.description),
              timestamp: nowIso(),
            },
            body: args.body,
          };
          renderOkfDocument(previewDoc);
          return textResult({ ok: true, path: docPath, dryRun: true });
        }

        const written = store.writePage({
          path: args.path,
          type: args.type,
          title: sanitizeFrontmatterLine(args.title),
          description: sanitizeFrontmatterLine(args.description),
          body: args.body,
          tags: args.tags,
        });
        return textResult({ ok: true, path: written.path });
      } catch (err) {
        return textResult({ ok: false, reason: err instanceof Error ? err.message : String(err) });
      }
    },
    // Re-writing the same page path upserts the same head — safe to retry.
    { annotations: { idempotentHint: true } },
  );

  const okfReport = tool(
    'okf_report',
    'Record a pure observability report for this okf-synthesize run — a summary of what was synthesized or maintained. Does NOT publish the bundle; publication happens automatically after the run succeeds via the executor finalize hook.',
    {
      summary: z.string().describe('Human-readable summary of the synthesis activity this run performed (or decided was unnecessary).'),
      details: z.record(z.string(), z.unknown()).optional().describe('Structured details as key-value pairs.'),
    },
    async (args) => {
      const report = insertReport({
        run_id: runId,
        project_id: projectId,
        agent_id: deps.agentId,
        action: OKF_REPORT_ACTION,
        summary: args.summary,
        details: args.details ? JSON.stringify(args.details) : null,
        created_at: epochSeconds(),
      });
      return textResult(report);
    },
    { annotations: { readOnlyHint: true } },
  );

  return [
    okfReadSources,
    okfReadSpec,
    okfListPages,
    okfReadPage,
    okfWritePlan,
    okfListPlannedPages,
    okfWritePage,
    okfReport,
  ];
}
