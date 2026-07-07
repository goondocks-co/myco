import fs from 'node:fs';
import path from 'node:path';
import { loadMergedConfig } from '@myco/config/loader.js';
import { ProjectVault } from '@myco/vault/project-vault.js';
import { resolveProjectRoot } from '@myco/vault/resolve.js';
import {
  projectScopeFromRequestContext,
  requestContextFromEnvironment,
} from '@myco/grove/request-context.js';
import { OkfBundle } from '@myco/okf/bundle.js';
import { OkfError, OKF_ERROR_HTTP_STATUS } from '@myco/okf/errors.js';
import { initVaultDb } from './shared.js';

/**
 * `myco okf …` — thin CLI over the OkfBundle capability. Parsing is a pure,
 * non-exiting function (`parseOkfCommand`) so Plan 8's docs anti-drift test can
 * import it; `run` owns DB init, capability construction, and the JSON envelope.
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

interface BundleContext {
  bundle: OkfBundle;
  scope: ReturnType<typeof projectScopeFromRequestContext>;
  projectRoot: string;
  machineId: string;
}

function buildBundle(vaultDir: string): BundleContext {
  const requestContext = requestContextFromEnvironment(process.env, vaultDir, { launchContextTenancy: true });
  const scope = projectScopeFromRequestContext(requestContext);
  const projectRoot = resolveProjectRoot(vaultDir);
  const config = loadMergedConfig(vaultDir, { groveId: requestContext.groveId ?? undefined });
  const bundle = new OkfBundle({
    projectRoot,
    vault: new ProjectVault(projectRoot),
    scope,
    projectId: requestContext.projectId ?? '',
    machineId: requestContext.machineId,
    config,
  });
  return { bundle, scope, projectRoot, machineId: requestContext.machineId };
}

async function dispatch(ctx: BundleContext, cmd: OkfCliCommand): Promise<unknown> {
  const { bundle, projectRoot } = ctx;
  switch (cmd.kind) {
    case 'validate': {
      // A CLI-supplied path is relative to the project root, not the process cwd.
      const target = cmd.path ? path.resolve(projectRoot, cmd.path) : undefined;
      const report = bundle.validate(target);
      return { ok: true, validation: report };
    }
    case 'status':
      return { ok: true, status: bundle.status() };
    case 'concept-save': {
      let markdown: string;
      try {
        markdown = fs.readFileSync(cmd.inputFile, 'utf8');
      } catch (err) {
        throw new OkfCliUserError('invalid_input_file', `cannot read --input file ${JSON.stringify(cmd.inputFile)}: ${(err as Error).message}`);
      }
      const result = await bundle.saveConcept({
        id: cmd.id,
        markdown,
        expectedGeneration: cmd.expectedGeneration,
        provenance: { actor: 'cli' },
      });
      return { ok: true, id: result.id, bundleGeneration: result.bundleGeneration };
    }
    case 'concept-supersede': {
      const result = await bundle.supersedeConcept({
        oldId: cmd.oldId,
        newId: cmd.newId,
        reason: cmd.reason,
        provenance: { actor: 'cli' },
      });
      return { ok: true, oldId: result.oldId, newId: result.newId, bundleGeneration: result.bundleGeneration };
    }
    case 'page-list':
      return { ok: true, pages: bundle.listPages() };
    case 'page-get':
      return { ok: true, page: bundle.getPage(cmd.path) };
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
    const result = await dispatch(buildBundle(vaultDir), parsed.cmd);
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
