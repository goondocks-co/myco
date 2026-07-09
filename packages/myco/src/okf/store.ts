/**
 * OkfStore — the single sanctioned writer for the DB-resident OKF wiki
 * (`okf_generations`, `okf_pages`, `okf_page_revisions`).
 *
 * Owns, at one chokepoint:
 *   - the fail-closed `okf_disabled` capability gate (every write),
 *   - identifier sanitization (`sanitizePublishedText`) on page content,
 *   - per-project generation allocation (MAX+1 inside the write transaction —
 *     SQLite serializes writers, so the read+insert pair is race-free),
 *   - the generation lifecycle: draft → published | blocked → superseded,
 *     with the publish-eligibility scan and link normalization at finalize,
 *   - transactional head-upsert + revision-insert per page write.
 *
 * Disk materialization of this content (the repo-visible `okf/` bundle) is
 * the future claim system's concern — nothing here touches the filesystem.
 */

import crypto from 'node:crypto';
import { epochSeconds } from '@myco/constants.js';
import { capabilityEnabled } from '@myco/config/capabilities.js';
import type { MycoConfig } from '@myco/config/schema.js';
import type { ProjectScope } from '@myco/grove/ids.js';
import { getDatabase } from '@myco/db/client.js';
import {
  getOkfGenerationById,
  getOkfPageByPath,
  insertOkfGeneration,
  insertOkfPage,
  insertOkfPageRevision,
  latestOkfGeneration,
  latestRevisionForPage,
  listOkfPages,
  listOpenOkfGenerations,
  listRevisionsForGeneration,
  nextOkfGenerationNumber,
  updateOkfGeneration,
  updateOkfPage,
  updateOkfPageRevisionBody,
  type OkfGenerationRow,
  type OkfPageRevisionRow,
} from '@myco/db/queries/okf.js';
import { OkfError } from './errors.js';
import { sanitizePublishedText } from './privacy.js';
import { scanContentSet, type PublishFinding } from './publish-eligibility.js';
import { normalizeBodyLinks } from './links.js';
import { validateWikiPlan, type WikiPlan } from './synthesis/plan.js';
import type { OkfFrontmatter } from './types.js';

export interface OkfStoreDeps {
  scope: ProjectScope;
  /** Grove project id rows are written under; null only for legacy scopes. */
  projectId: string | null;
  machineId: string;
  config: MycoConfig;
  now?: () => Date;
}

export interface OkfWrittenPage {
  pageId: string;
  revisionId: string;
  path: string;
  pageGeneration: number;
}

export interface OkfFinalizeResult {
  status: 'published' | 'blocked';
  generation: OkfGenerationRow;
  findings: PublishFinding[];
  pageCount: number;
}

/** last_run_ref payload — the okf-synthesize-due baseline carried on the generation row. */
export interface OkfLastRunRef {
  headSha: string | null;
  maxVaultUpdatedAt: number;
}

export class OkfStore {
  private readonly now: () => Date;

  constructor(private readonly deps: OkfStoreDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /** Fail-closed capability gate — the ONE place `okf_disabled` is enforced for row writes. */
  private assertEnabled(): void {
    if (!capabilityEnabled(this.deps.config, 'okf')) {
      throw new OkfError('okf_disabled', 'OKF capability is disabled for this project');
    }
  }

  private epoch(): number {
    return Math.floor(this.now().getTime() / 1000);
  }

  // -------------------------------------------------------------------
  // Generation lifecycle
  // -------------------------------------------------------------------

  /**
   * Create the draft generation a synthesis run writes against. Validates the
   * plan (page cap, slug-safe paths, reserved basenames), supersedes any prior
   * open (draft or blocked) generation — their rows remain as history and a
   * stale publish-block stops gating the UI — and allocates the per-project
   * generation number inside the same transaction as the insert.
   */
  createDraftGeneration(input: { runId: string | null; plan: WikiPlan; inputsHash?: string }): OkfGenerationRow {
    this.assertEnabled();
    const errors = validateWikiPlan(input.plan);
    if (errors.length > 0) {
      throw new OkfError('okf_maintain_failed', `wiki plan rejected: ${errors.join('; ')}`, { errors });
    }
    const db = getDatabase();
    const at = this.epoch();
    db.prepare('BEGIN').run();
    try {
      for (const open of listOpenOkfGenerations(this.deps.scope)) {
        updateOkfGeneration(open.id, { status: 'superseded', updated_at: at });
      }
      const row = insertOkfGeneration({
        id: crypto.randomUUID(),
        project_id: this.deps.projectId,
        machine_id: this.deps.machineId,
        generation: nextOkfGenerationNumber(this.deps.scope),
        run_id: input.runId,
        status: 'draft',
        plan: JSON.stringify(input.plan),
        page_count: 0,
        log_summary: '',
        inputs_hash: input.inputsHash ?? '',
        last_run_ref: null,
        findings: '[]',
        created_at: at,
        updated_at: at,
      });
      db.prepare('COMMIT').run();
      return row;
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  /** The draft generation a run writes against, or null when none is open. */
  currentDraft(): OkfGenerationRow | null {
    return latestOkfGeneration(this.deps.scope, ['draft']);
  }

  /** Latest published generation — what read surfaces render. */
  latestPublished(): OkfGenerationRow | null {
    return latestOkfGeneration(this.deps.scope, ['published']);
  }

  /** Latest generation of any status — drives the UI status/block banner. */
  latest(): OkfGenerationRow | null {
    return latestOkfGeneration(this.deps.scope);
  }

  // -------------------------------------------------------------------
  // Page writes
  // -------------------------------------------------------------------

  /**
   * Write one page against the open draft generation: sanitize, upsert the
   * head, insert the full-content revision — one transaction, sync rows
   * enqueued by the query layer. Rejects when no draft is open.
   */
  writePage(input: {
    path: string;
    type: string;
    title: string;
    description: string;
    body: string;
    tags?: string[];
    rationale?: string;
    /** 'authored' for the editorial (concept) surface; synthesis writes derive created/refined. */
    action?: 'created' | 'refined' | 'authored';
  }): OkfWrittenPage {
    this.assertEnabled();
    const draft = this.currentDraft();
    if (!draft) {
      throw new OkfError('okf_maintain_failed', 'no open draft generation — okf_write_plan must run before pages are written');
    }
    return this.writePageToGeneration(draft.id, input);
  }

  /**
   * Editorial write (MCP/CLI concept surface): wraps the page in its own
   * single-page generation so hand-authored pages publish immediately without
   * a synthesis run, passing the same scan gate.
   */
  writeAuthoredPage(input: {
    path: string;
    type: string;
    title: string;
    description: string;
    body: string;
    tags?: string[];
    rationale?: string;
  }): OkfFinalizeResult {
    this.assertEnabled();
    const plan: WikiPlan = {
      generatedAt: this.now().toISOString(),
      sinceRef: '',
      pages: [{
        path: input.path,
        type: input.type,
        title: input.title,
        rationale: input.rationale ?? 'Hand-authored page',
        sourceRefs: [],
      }],
    };
    const draft = this.createDraftGeneration({ runId: null, plan });
    this.writePageToGeneration(draft.id, { ...input, action: 'authored' });
    return this.finalizeGeneration(draft.id, { logSummary: `Authored ${input.path}.` });
  }

  private writePageToGeneration(
    generationId: string,
    input: {
      path: string;
      type: string;
      title: string;
      description: string;
      body: string;
      tags?: string[];
      rationale?: string;
      action?: 'created' | 'refined' | 'authored';
    },
  ): OkfWrittenPage {
    const docPath = input.path.endsWith('.md') ? input.path : `${input.path}.md`;
    const at = this.epoch();
    const sanitizedTitle = sanitizePublishedText(input.title).replace(/\s+/g, ' ').trim();
    const sanitizedDescription = sanitizePublishedText(input.description).replace(/\s+/g, ' ').trim();
    const sanitizedBody = sanitizePublishedText(input.body);
    const tags = (input.tags ?? []).map((t) => sanitizePublishedText(t));

    const db = getDatabase();
    db.prepare('BEGIN').run();
    try {
      const existing = getOkfPageByPath(this.deps.scope, docPath);
      let pageId: string;
      let pageGeneration: number;
      if (existing) {
        pageGeneration = existing.generation + 1;
        updateOkfPage(existing.id, {
          type: input.type.trim() || 'note',
          title: sanitizedTitle,
          description: sanitizedDescription,
          tags: JSON.stringify(tags),
          status: 'active',
          generation: pageGeneration,
          updated_at: at,
        });
        pageId = existing.id;
      } else {
        pageGeneration = 1;
        pageId = crypto.randomUUID();
        insertOkfPage({
          id: pageId,
          project_id: this.deps.projectId,
          machine_id: this.deps.machineId,
          path: docPath,
          type: input.type.trim() || 'note',
          title: sanitizedTitle,
          description: sanitizedDescription,
          tags: JSON.stringify(tags),
          status: 'active',
          generation: 1,
          created_at: at,
          updated_at: at,
        });
      }

      const frontmatter: OkfFrontmatter = {
        type: input.type.trim() || 'note',
        title: sanitizedTitle,
        description: sanitizedDescription,
        timestamp: this.now().toISOString(),
        ...(tags.length > 0 ? { tags } : {}),
      };
      const revision = insertOkfPageRevision({
        id: crypto.randomUUID(),
        project_id: this.deps.projectId,
        machine_id: this.deps.machineId,
        page_id: pageId,
        page_generation: pageGeneration,
        bundle_generation_id: generationId,
        action: input.action ?? (existing ? 'refined' : 'created'),
        rationale: input.rationale ?? '',
        frontmatter: JSON.stringify(frontmatter),
        body: sanitizedBody,
        created_at: at,
      });
      db.prepare('COMMIT').run();
      return { pageId, revisionId: revision.id, path: docPath, pageGeneration };
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
  }

  // -------------------------------------------------------------------
  // Finalize + acknowledge
  // -------------------------------------------------------------------

  /**
   * Finalize a draft generation: normalize cross-links over the generation's
   * page set, run the publish-eligibility scan (secrets and absolute local
   * paths block; UUIDs were already rewritten at write time), and flip the
   * status — 'published' on a clean scan, 'blocked' with findings otherwise.
   */
  finalizeGeneration(
    generationId: string,
    opts?: { logSummary?: string; inputsHash?: string; lastRunRef?: OkfLastRunRef | null },
  ): OkfFinalizeResult {
    this.assertEnabled();
    const generation = getOkfGenerationById(generationId);
    if (!generation) throw new OkfError('okf_maintain_failed', `unknown generation: ${generationId}`);
    if (generation.status !== 'draft') {
      throw new OkfError('okf_generation_conflict', `generation ${generation.generation} is ${generation.status}, not draft`);
    }
    const at = this.epoch();
    const revisions = listRevisionsForGeneration(generationId);

    // Current wiki page set = this generation's pages plus every still-active
    // page carried forward from earlier generations — links may point at both.
    const activePaths = new Set<string>(this.listActivePagePaths());
    for (const rev of revisions) activePaths.add(rev.path);

    for (const rev of revisions) {
      const normalized = normalizeBodyLinks(rev.body, rev.path, activePaths);
      if (normalized.body !== rev.body) {
        updateOkfPageRevisionBody(rev.id, normalized.body);
        rev.body = normalized.body;
      }
    }

    const findings = scanContentSet(revisions.map((rev) => ({ path: rev.path, content: rev.body })));
    const status: 'published' | 'blocked' = findings.length === 0 ? 'published' : 'blocked';
    const updated = updateOkfGeneration(generationId, {
      status,
      page_count: revisions.length,
      log_summary: opts?.logSummary ?? `Synthesized ${revisions.length} page${revisions.length === 1 ? '' : 's'}.`,
      ...(opts?.inputsHash !== undefined ? { inputs_hash: opts.inputsHash } : {}),
      last_run_ref: opts?.lastRunRef ? JSON.stringify(opts.lastRunRef) : null,
      findings: JSON.stringify(findings),
      updated_at: at,
    })!;
    return { status, generation: updated, findings, pageCount: revisions.length };
  }

  /**
   * Editorial supersede: retire the old page head, recording a final revision
   * that carries its current body and the supersession reason — auditable
   * history without content loss. The replacement page must already exist.
   */
  supersedePage(oldPath: string, newPath: string, reason: string): { retired: string; replacement: string } {
    this.assertEnabled();
    const oldDoc = oldPath.endsWith('.md') ? oldPath : `${oldPath}.md`;
    const newDoc = newPath.endsWith('.md') ? newPath : `${newPath}.md`;
    const oldHead = getOkfPageByPath(this.deps.scope, oldDoc);
    if (!oldHead || oldHead.status !== 'active') {
      throw new OkfError('okf_maintain_failed', `no active page at ${oldDoc} to supersede`);
    }
    const replacement = getOkfPageByPath(this.deps.scope, newDoc);
    if (!replacement || replacement.status !== 'active') {
      throw new OkfError('okf_maintain_failed', `replacement page ${newDoc} does not exist — write it first`);
    }
    const at = this.epoch();
    const current = latestRevisionForPage(oldHead.id);
    const db = getDatabase();
    db.prepare('BEGIN').run();
    try {
      insertOkfPageRevision({
        id: crypto.randomUUID(),
        project_id: this.deps.projectId,
        machine_id: this.deps.machineId,
        page_id: oldHead.id,
        page_generation: oldHead.generation + 1,
        bundle_generation_id: current?.bundle_generation_id ?? '',
        action: 'authored',
        rationale: `Superseded by ${newDoc}: ${reason}`,
        frontmatter: current?.frontmatter ?? JSON.stringify({ type: oldHead.type }),
        body: current?.body ?? '',
        created_at: at,
      });
      updateOkfPage(oldHead.id, { status: 'retired', generation: oldHead.generation + 1, updated_at: at });
      db.prepare('COMMIT').run();
    } catch (err) {
      db.prepare('ROLLBACK').run();
      throw err;
    }
    return { retired: oldDoc, replacement: newDoc };
  }

  /**
   * Acknowledge the latest blocked generation's findings and publish it —
   * the content is already synthesized and paid for; acknowledging means
   * ship, not run-again. Returns null when nothing is blocked.
   */
  acknowledge(): OkfGenerationRow | null {
    this.assertEnabled();
    const blocked = latestOkfGeneration(this.deps.scope, ['blocked']);
    if (!blocked) return null;
    return updateOkfGeneration(blocked.id, { status: 'published', updated_at: this.epoch() });
  }

  // -------------------------------------------------------------------
  // Reads the write paths need (full read surface lives in db/queries/okf.ts)
  // -------------------------------------------------------------------

  /** Bundle-relative paths of every active page head (the current wiki tree). */
  listActivePagePaths(): string[] {
    return listOkfPages(this.deps.scope, 'active').map((p) => p.path);
  }

  /** Current content of one active page (head + latest revision), or null. */
  readPage(pagePath: string): { path: string; frontmatter: OkfFrontmatter; body: string } | null {
    const docPath = pagePath.endsWith('.md') ? pagePath : `${pagePath}.md`;
    const head = getOkfPageByPath(this.deps.scope, docPath);
    if (!head || head.status !== 'active') return null;
    const revision = latestRevisionForPage(head.id);
    if (!revision) return null;
    return {
      path: head.path,
      frontmatter: parseRevisionFrontmatter(revision),
      body: revision.body,
    };
  }
}

function parseRevisionFrontmatter(revision: OkfPageRevisionRow): OkfFrontmatter {
  try {
    return JSON.parse(revision.frontmatter) as OkfFrontmatter;
  } catch {
    return { type: 'note' };
  }
}

