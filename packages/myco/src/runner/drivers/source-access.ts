import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { RUN_REPOSITORY_DIR, RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';
import { RUN_INSTRUCTIONS_FILES } from '../mcp-config.js';

/** Physical source roots and individually declared run inputs; configuration files are never inputs. */
export interface SourceAccess {
  base: string;
  root: string;
  files: readonly string[];
  excluded?: ReadonlySet<string>;
  refresh?: () => void;
}

/** Maximum synchronous work for a search permission; expiry carries no permission. */
export const SOURCE_PERMISSION_BUDGET_MS = 100;

/** A checkout must be a physical child of its run, rather than an alias to host files. */
export function sourceAccess(runDir: string): SourceAccess {
  const base = nodeFs.realpathSync(runDir);
  const root = nodeFs.realpathSync(nodePath.join(base, RUN_REPOSITORY_DIR));
  if (nodePath.dirname(root) !== base || nodePath.basename(root) !== RUN_REPOSITORY_DIR) throw new Error('Source checkout is outside its run directory');
  const files = [...RUN_INSTRUCTIONS_FILES, RUN_REPOSITORY_DIGESTS_FILE].flatMap((name) => {
    const path = nodePath.join(base, name);
    if (!nodeFs.existsSync(path)) return [];
    if (nodeFs.realpathSync(path) !== path || !nodeFs.statSync(path).isFile()) throw new Error('Run input is not a regular physical file');
    return [path];
  });
  const excluded = new Set<string>();
  let directories = new Map<string, string>();
  const versionOf = (directory: string): string => {
    const stat = nodeFs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory()) throw new Error('Source directory is no longer physical');
    return `${stat.dev}:${stat.ino}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const rebuild = (deadline = Infinity): void => {
    const indexed = new Map<string, string>();
    const walk = (directory: string): void => {
      if (performance.now() > deadline) throw new Error('Source index refresh exceeded its permission budget');
      indexed.set(directory, versionOf(directory));
      for (const entry of nodeFs.readdirSync(directory, { withFileTypes: true })) {
        const named = nodePath.join(directory, entry.name);
        if (entry.isSymbolicLink()) {
          let target: string | null;
          try { target = nodeFs.realpathSync(named); } catch { target = null; }
          // Search engines may follow links; the disposable checkout contains only source targets.
          if (target === null || !contained(root, target)) {
            nodeFs.unlinkSync(named);
            excluded.add(named);
          }
        } else if (entry.isDirectory()) walk(named);
      }
      indexed.set(directory, versionOf(directory));
    };
    walk(root);
    if (performance.now() > deadline) throw new Error('Source index refresh exceeded its permission budget');
    directories = indexed;
  };
  rebuild();
  return { base, root, files, excluded, refresh: () => {
    if (nodeFs.realpathSync(root) !== root) throw new Error('Source checkout moved outside its physical root');
    const deadline = performance.now() + SOURCE_PERMISSION_BUDGET_MS;
    for (const [directory, version] of directories) {
      if (performance.now() > deadline) throw new Error('Source index check exceeded its permission budget');
      if (versionOf(directory) !== version) { rebuild(deadline); return; }
    }
    if (performance.now() > deadline) throw new Error('Source index check exceeded its permission budget');
  } };
}

/** Whether the resolved target is within a physical root on the active platform. */
function contained(root: string, target: string, path = nodePath): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/** Explicit paths resolve physically; search roots use the run's cached, link-excluded checkout. */
export function sourceAccessAllows(policy: SourceAccess, paths: readonly string[], _recursive: boolean, fs: { realpathSync(path: string): string } = nodeFs, path = nodePath): boolean {
  try {
    if (_recursive) policy.refresh?.();
    if (fs.realpathSync(policy.root) !== policy.root) return false;
    return paths.length > 0 && paths.every((named) => {
      if (typeof named !== 'string' || named.length === 0 || named.split(/[\\/]/).includes('..')) return false;
      const physical = fs.realpathSync(path.resolve(policy.root, named));
      return contained(policy.root, physical, path) || policy.files.includes(physical);
    });
  } catch {
    // Unresolvable targets carry no read permission.
    return false;
  }
}

/** All path-bearing input fields and locations participate in one file permission decision. */
export function sourceToolAllows(policy: SourceAccess, tool: string, input: Record<string, unknown>, locations?: unknown): boolean {
  if (!['Read', 'Glob', 'Grep', 'Search'].includes(tool)) return false;
  const search = tool !== 'Read';
  if (search && input.path !== undefined && typeof input.path !== 'string') return false;
  if (!search && !['path', 'file_path', 'filePath'].some((field) => typeof input[field] === 'string') && !Array.isArray(locations)) return false;
  const paths: string[] = [];
  for (const field of ['path', 'file_path', 'filePath', 'cwd', 'workdir'] as const) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string') return false;
    paths.push(input[field]);
  }
  if (locations !== undefined) {
    if (!Array.isArray(locations)) return false;
    for (const location of locations) {
      if (location === null || typeof location !== 'object' || typeof location.path !== 'string') return false;
      paths.push(location.path);
    }
  }
  const patterns = [input.glob, ...(['Glob', 'Search'].includes(tool) ? [input.pattern] : [])];
  for (const pattern of patterns) {
    if (pattern === undefined) continue;
    if (typeof pattern !== 'string' || nodePath.isAbsolute(pattern) || pattern.startsWith('~')
      || /[\\{}()[\]!]/.test(pattern) || pattern.split('/').includes('..')) return false;
  }
  if (search && input.path === undefined) paths.push(policy.root);
  return sourceAccessAllows(policy, paths, search);
}
