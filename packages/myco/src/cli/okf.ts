import fs from 'node:fs';
import { loadMergedConfig } from '@myco/config/loader.js';
import {
  projectScopeFromRequestContext,
  requestContextFromEnvironment,
} from '@myco/grove/request-context.js';
import { OkfStore } from '@myco/okf/store.js';
import { OkfError, OKF_ERROR_HTTP_STATUS } from '@myco/okf/errors.js';
import { validateWikiRows } from '@myco/okf/validate.js';
import { parseConceptDoc } from '@myco/okf/frontmatter.js';
import {
  latestOkfGeneration,
  latestRevisionForPage,
  listOkfPages,
} from '@myco/db/queries/okf.js';
import { initVaultDb } from './shared.js';

/**
 * `myco okf …` — thin CLI over the DB-resident wiki: reads via the okf query
 * layer, writes via the single `OkfStore` capability (the same code path the
 * daemon API and MCP surface use). Parsing is a pure, non-exiting function
 * (`parseOkfCommand`) so the docs anti-drift test can import it; `run` owns
 * DB init, store construction, and the JSON envelope.
 *
 * Exit codes: 0 success; 1 user error (bad args / OkfError with a 4xx code);
 * 2 runtime error (OkfError with a 5xx code, or any non-OkfError). `run` sets
 * `process.exitCode` and returns instead of throwing, so cli.ts's top-level
 * catch (which exits 1 on any uncaught throw) never masks the intended code.
 */

export type OkfCliCommand =
  | { kind: 'validate'; path?: string }
  | { kind: 'status' }
  | { kind: 'concept-save'; id: string; inputFile: string; expectedGeneration?: number }
  | { kind: 'concept-supersede'; oldId: string; newId: string; reason: string }
  | { kind: 'page-list' }
  | { kind: 'page-get'; path: string };

export type ParseResult = { ok: true; cmd: OkfCliCommand } | { ok: false; error: string };

/** A bad invocation (e.g. an unreadable --input file) — exit 1, not a runtime error. */
class OkfCliUserError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function takeFlagValue(args: string[], flag: string): { value?: string; rest: string[] } {
  const idx = args.indexOf(flag);
  if (idx === -1) return { rest: args };
  const value = args[idx + 1];
  if (value === undefined || value.startsWith('--')) return { rest: args }; // caller validates required-ness
  return { value, rest: [...args.slice(0, idx), ...args.slice(idx + 2)] };
}

/** Pure argv → command parser. Never exits, never touches the filesystem. */
export function parseOkfCommand(argv: string[]): ParseResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'validate':
      return { ok: true, cmd: { kind: 'validate', path: rest[0] } };
    case 'status':
      return { ok: true, cmd: { kind: 'status' } };
    case 'concept': {
      const [op, ...opArgs] = rest;
      if (op === 'save') {
        const id = takeFlagValue(opArgs, '--id').value;
        const inputFile = takeFlagValue(opArgs, '--input').value;
        const expectedRaw = takeFlagValue(opArgs, '--expected-generation').value;
        if (!id) return { ok: false, error: 'concept save requires --id concepts/<slug>' };
        if (!inputFile) return { ok: false, error: 'concept save requires --input @<file.md>' };
        const bareFile = inputFile.startsWith('@') ? inputFile.slice(1) : inputFile;
        let expectedGeneration: number | undefined;
        if (expectedRaw !== undefined) {
          expectedGeneration = Number(expectedRaw);
          if (!Number.isInteger(expectedGeneration)) {
            return { ok: false, error: `--expected-generation must be an integer, got ${expectedRaw}` };
          }
        }
        return { ok: true, cmd: { kind: 'concept-save', id, inputFile: bareFile, expectedGeneration } };
      }
      if (op === 'supersede') {
        // Consume --reason by INDEX (takeFlagValue removes the flag + its
        // value from `rest`), so a reason string that equals a concept id
        // can't accidentally strip that id from the positionals.
        const reasonTake = takeFlagValue(opArgs, '--reason');
        const reason = reasonTake.value;
        const positionals = reasonTake.rest.filter((a) => !a.startsWith('--'));
        const [oldId, newId] = positionals;
        if (!oldId || !newId) return { ok: false, error: 'concept supersede requires <old-id> <new-id>' };
        if (!reason) return { ok: false, error: 'concept supersede requires --reason "<text>"' };
        return { ok: true, cmd: { kind: 'concept-supersede', oldId, newId, reason } };
      }
      return { ok: false, error: 'usage: myco okf concept <save|supersede>' };
    }
    case 'page': {
      const [op, ...opArgs] = rest;
      if (op === 'list') return { ok: true, cmd: { kind: 'page-list' } };
      if (op === 'get') {
        const pagePath = opArgs[0];
        if (!pagePath) return { ok: false, error: 'page get requires <path>' };
        return { ok: true, cmd: { kind: 'page-get', path: pagePath } };
      }
      return { ok: false, error: 'usage: myco okf page <list|get>' };
    }
    default:
      return { ok: false, error: 'usage: myco okf <validate|status|concept|page>' };
  }
}

interface StoreContext {
  store: OkfStore;
  scope: ReturnType<typeof projectScopeFromRequestContext>;
}

function buildStore(vaultDir: string): StoreContext {
  const requestContext = requestContextFromEnvironment(process.env, vaultDir, { launchContextTenancy: true });
  const scope = projectScopeFromRequestContext(requestContext);
  const config = loadMergedConfig(vaultDir, { groveId: requestContext.groveId ?? undefined });
  const store = new OkfStore({
    scope,
    projectId: requestContext.projectId ?? null,
    machineId: requestContext.machineId,
    config,
  });
  return { store, scope };
}

function currentWikiRows(ctx: StoreContext): Array<{ path: string; frontmatter: Record<string, unknown>; body: string }> {
  return listOkfPages(ctx.scope, 'active').map((head) => {
    const revision = latestRevisionForPage(head.id);
    let frontmatter: Record<string, unknown>;
    try {
      frontmatter = JSON.parse(revision?.frontmatter ?? '{}') as Record<string, unknown>;
    } catch {
      frontmatter = { type: head.type };
    }
    return { path: head.path, frontmatter, body: revision?.body ?? '' };
  });
}

async function dispatch(ctx: StoreContext, cmd: OkfCliCommand): Promise<unknown> {
  const { store, scope } = ctx;
  switch (cmd.kind) {
    case 'validate':
      return { ok: true, validation: validateWikiRows(currentWikiRows(ctx)) };
    case 'status': {
      const pages = listOkfPages(scope, 'active');
      const published = latestOkfGeneration(scope, ['published']);
      const latest = latestOkfGeneration(scope);
      return {
        ok: true,
        status: {
          bundleExists: pages.length > 0,
          bundleGeneration: published?.generation ?? null,
          pageCount: pages.length,
          lastResult: latest?.status ?? null,
          generatedAt: published ? new Date(published.updated_at * 1000).toISOString() : null,
        },
      };
    }
    case 'concept-save': {
      let markdown: string;
      try {
        markdown = fs.readFileSync(cmd.inputFile, 'utf8');
      } catch (err) {
        throw new OkfCliUserError('invalid_input_file', `cannot read --input file ${JSON.stringify(cmd.inputFile)}: ${(err as Error).message}`);
      }
      if (typeof cmd.expectedGeneration === 'number') {
        const current = latestOkfGeneration(scope, ['published'])?.generation ?? null;
        if (current !== null && current !== cmd.expectedGeneration) {
          throw new OkfError('okf_generation_conflict', `wiki is at generation ${current}, caller expected ${cmd.expectedGeneration}`);
        }
      }
      const { frontmatter, body } = parseConceptDoc(markdown);
      const result = store.writeAuthoredPage({
        path: cmd.id,
        type: typeof frontmatter.type === 'string' ? frontmatter.type : 'concept',
        title: typeof frontmatter.title === 'string' ? frontmatter.title : cmd.id,
        description: typeof frontmatter.description === 'string' ? frontmatter.description : '',
        body,
        tags: Array.isArray(frontmatter.tags) ? (frontmatter.tags as string[]) : undefined,
      });
      return { ok: true, id: cmd.id, status: result.status, bundleGeneration: result.generation.generation };
    }
    case 'concept-supersede': {
      const result = store.supersedePage(cmd.oldId, cmd.newId, cmd.reason);
      return { ok: true, oldId: result.retired, newId: result.replacement };
    }
    case 'page-list':
      return {
        ok: true,
        pages: listOkfPages(scope, 'active').map((p) => ({
          path: p.path,
          type: p.type,
          title: p.title,
          description: p.description,
          timestamp: new Date(p.updated_at * 1000).toISOString(),
        })),
      };
    case 'page-get': {
      const page = store.readPage(cmd.path);
      if (!page) return { ok: true, page: null };
      const fm = page.frontmatter as Record<string, unknown>;
      return {
        ok: true,
        page: {
          path: page.path,
          type: typeof fm.type === 'string' ? fm.type : 'note',
          title: typeof fm.title === 'string' ? fm.title : undefined,
          description: typeof fm.description === 'string' ? fm.description : undefined,
          timestamp: typeof fm.timestamp === 'string' ? fm.timestamp : undefined,
          body: page.body,
        },
      };
    }
  }
}

export async function run(args: string[], vaultDir: string): Promise<void> {
  const parsed = parseOkfCommand(args);
  if (!parsed.ok) {
    console.log(JSON.stringify({ ok: false, error: { code: 'invalid_arguments', message: parsed.error } }, null, 2));
    process.exitCode = 1;
    return;
  }

  const cleanup = await initVaultDb(vaultDir);
  try {
    const result = await dispatch(buildStore(vaultDir), parsed.cmd);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof OkfCliUserError) {
      console.log(JSON.stringify({ ok: false, error: { code: err.code, message: err.message } }, null, 2));
      process.exitCode = 1;
      return;
    }
    if (err instanceof OkfError) {
      console.log(
        JSON.stringify(
          { ok: false, error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } },
          null,
          2,
        ),
      );
      process.exitCode = OKF_ERROR_HTTP_STATUS[err.code] >= 500 ? 2 : 1;
      return;
    }
    console.log(
      JSON.stringify({ ok: false, error: { code: 'okf_runtime_error', message: (err as Error).message } }, null, 2),
    );
    process.exitCode = 2;
  } finally {
    cleanup();
  }
}
