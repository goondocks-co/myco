import nodeFs from 'node:fs';
import nodePath from 'node:path';
import { RUN_REPOSITORY_DIR, RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';
import { RUN_INSTRUCTIONS_FILES } from '../mcp-config.js';

/** Physical source roots and individually declared run inputs; configuration files are never inputs. */
export interface SourceAccess {
  base: string;
  root: string;
  files: readonly string[];
}

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
  return { base, root, files };
}

/** A physical target and every searched descendant must be declared source inputs. */
export function sourceAccessAllows(policy: SourceAccess, paths: readonly string[], recursive: boolean, fs = nodeFs, path = nodePath): boolean {
  try {
    const within = (target: string): boolean => {
      const relative = path.relative(policy.root, target);
      return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    };
    if (fs.realpathSync(policy.root) !== policy.root) return false;
    const seen = new Set<string>();
    const allowed = (named: string): boolean => {
      const physical = fs.realpathSync(named);
      if (!within(physical) && !policy.files.includes(physical)) return false;
      if (!recursive || !fs.statSync(physical).isDirectory() || seen.has(physical)) return true;
      seen.add(physical);
      return fs.readdirSync(physical).every((entry) => allowed(path.join(physical, entry)));
    };
    return paths.length > 0 && paths.every((named) => typeof named === 'string' && named.length > 0 && !named.split(/[\\/]/).includes('..') && allowed(path.resolve(policy.base, named)));
  } catch {
    // Unresolvable targets carry no read permission.
    return false;
  }
}

/** File permissions use Claude's absolute-path syntax, whose leading double slash names the filesystem root. */
export function sourceFileRules(policy: SourceAccess): string[] {
  const absolute = (path: string): string => `/${path.replaceAll('\\', '/')}`;
  if ([policy.root, ...policy.files].some((path) => /[(),*?\[\]{}!\n\r]/.test(path))) throw new Error('Source path cannot be represented by a literal permission rule');
  return ['Read', 'Glob', 'Grep'].flatMap((tool) => [`${tool}(${absolute(policy.root)}/**)`, ...policy.files.map((file) => `${tool}(${absolute(file)})`)]);
}

/** All path-bearing input fields and locations participate in one file permission decision. */
export function sourceToolAllows(policy: SourceAccess, tool: string, input: Record<string, unknown>, locations?: unknown): boolean {
  if (!['Read', 'Glob', 'Grep', 'Search'].includes(tool)) return false;
  const search = tool !== 'Read';
  if (search && typeof input.path !== 'string') return false;
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
  return sourceAccessAllows(policy, paths, search);
}
