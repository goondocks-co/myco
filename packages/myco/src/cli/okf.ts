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
import type { OkfBundleInclude, OkfSporeStatusFilter } from '@myco/okf/types.js';
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

const INCLUDE_KINDS = ['spores', 'canopy', 'concepts', 'guides'] as const;
const SPORE_STATUSES = ['active', 'superseded', 'consolidated', 'obsolete', 'all'] as const;

export type OkfCliCommand =
  | {
      kind: 'maintain';
      include?: OkfBundleInclude;
      sporeStatus: OkfSporeStatusFilter;
      includeUndescribedCanopy: boolean;
      dryRun: boolean;
      oneShot: boolean;
      out?: string;
      overwrite: boolean;
      acknowledgePublish: boolean;
    }
  | { kind: 'validate'; path?: string }
  | { kind: 'status' }
  | { kind: 'concept-save'; id: string; inputFile: string; expectedGeneration?: number }
  | { kind: 'concept-supersede'; oldId: string; newId: string; reason: string }
  | { kind: 'concept-list' }
  | { kind: 'concept-get'; id: string };

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

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

/** Pure argv → command parser. Never exits, never touches the filesystem. */
export function parseOkfCommand(argv: string[]): ParseResult {
  const [sub, ...rest] = argv;
  switch (sub) {
    case 'maintain': {
      const dryRun = hasFlag(rest, '--dry-run');
      const oneShot = hasFlag(rest, '--one-shot');
      const overwrite = hasFlag(rest, '--overwrite');
      const acknowledgePublish = hasFlag(rest, '--acknowledge-publish');
      const includeUndescribedCanopy = hasFlag(rest, '--include-undescribed-canopy');
      const out = takeFlagValue(rest, '--out').value;
      const includeRaw = takeFlagValue(rest, '--include').value;
      let include: OkfBundleInclude | undefined;
      if (includeRaw !== undefined) {
        const parts = includeRaw.split(',').map((p) => p.trim()).filter(Boolean);
        const bad = parts.filter((p) => !(INCLUDE_KINDS as readonly string[]).includes(p));
        if (bad.length > 0) return { ok: false, error: `unknown --include kinds: ${bad.join(', ')}` };
        include = {
          spores: parts.includes('spores'),
          canopy: parts.includes('canopy'),
          concepts: parts.includes('concepts'),
          guides: parts.includes('guides'),
        };
      }
      const sporeStatusRaw = takeFlagValue(rest, '--spore-status').value ?? 'active';
      if (!(SPORE_STATUSES as readonly string[]).includes(sporeStatusRaw)) {
        return { ok: false, error: `unknown --spore-status: ${sporeStatusRaw}` };
      }
      if (oneShot && !out) return { ok: false, error: '--one-shot requires --out <path>' };
      return {
        ok: true,
        cmd: {
          kind: 'maintain',
          include,
          sporeStatus: sporeStatusRaw as OkfSporeStatusFilter,
          includeUndescribedCanopy,
          dryRun,
          oneShot,
          out,
          overwrite,
          acknowledgePublish,
        },
      };
    }
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
      if (op === 'list') return { ok: true, cmd: { kind: 'concept-list' } };
      if (op === 'get') {
        const id = opArgs[0];
        if (!id) return { ok: false, error: 'concept get requires <id>' };
        return { ok: true, cmd: { kind: 'concept-get', id } };
      }
      return { ok: false, error: 'usage: myco okf concept <save|supersede|list|get>' };
    }
    default:
      return { ok: false, error: 'usage: myco okf <maintain|validate|status|concept>' };
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
  const { bundle, scope, projectRoot, machineId } = ctx;
  switch (cmd.kind) {
    case 'maintain': {
      const result = await bundle.maintain({
        scope,
        projectRoot,
        machineId,
        mode: 'published',
        include: cmd.include,
        sporeStatus: cmd.sporeStatus,
        includeUndescribedCanopy: cmd.includeUndescribedCanopy,
        outputRoot: cmd.out,
        dryRun: cmd.dryRun,
        oneShot: cmd.oneShot,
        allowExternalOutput: cmd.out !== undefined,
        overwrite: cmd.overwrite,
        acknowledgePublish: cmd.acknowledgePublish,
      });
      return {
        ok: true,
        outputRoot: result.outputRoot,
        dryRun: result.dryRun,
        unchanged: result.unchanged ?? false,
        conceptCount: result.conceptCount,
        byType: result.byType,
        warnings: result.warnings,
        publishEligibility: result.publishEligibility,
        validation: {
          ok: result.validation.ok,
          level: result.validation.level,
          filesChecked: result.validation.filesChecked,
          conceptsChecked: result.validation.conceptsChecked,
        },
      };
    }
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
    case 'concept-list':
      return { ok: true, concepts: bundle.listConcepts() };
    case 'concept-get': {
      const got = bundle.getConcept(cmd.id);
      if (!got) return { ok: true, concept: null };
      return { ok: true, concept: { id: cmd.id, raw: got.raw } };
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
