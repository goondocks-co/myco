import path from 'node:path';
import { cliVerbModules, closureOf, entryFiles, moduleKey, REPO_ROOT, withoutShebang, type Closure } from './import-closure.ts';
import { isLegacy } from './legacy-boundary.ts';
const SRC = path.join(REPO_ROOT, 'packages', 'myco', 'src');
/**
 * The 2.0 entry points under `packages/myco/src` (`/**` = every file under), walked with every import they make, beside
 * the CLI itself and every verb module it dispatches to that is not a 1.4 verb (`cliVerbModules`).
 */
const ENTRIES: readonly string[] = [
  'cli.ts', 'entries/**', 'hooks/**', 'member/**', 'runner/**', 'server/**',
  'mcp/stdio-bridge.ts', 'mcp/deployment-upstream.ts', 'mcp/client-call.ts',
];

/** A per-target entry with its embedded-file imports (`with { type: 'file' }`) taken out: those embed bytes, not code. */
const withoutEmbeds = (_file: string, text: string): string =>
  text.replace(/^import\s+\w+\s+from\s+['"][^'"]+['"]\s+with\s*\{\s*type:\s*['"]file['"]\s*\};?\s*$/gm, '');

/** The whole 2.0 closure, stopped at the 1.4 boundary: the CLI and every verb it dispatches, the other entry points, and the Deployment. */
export function walk(mutate?: (file: string, text: string) => string): { myco: Closure; server: Closure } {
  const entries = [
    ...entryFiles(SRC, ENTRIES),
    ...cliVerbModules(SRC, (file) => isLegacy(moduleKey(file))),
  ];
  const myco = closureOf(entries, { stopAt: isLegacy, source: (file, text) => withoutEmbeds(file, withoutShebang(file, mutate ? mutate(file, text) : text)) });
  const server = closureOf(entryFiles(path.join(REPO_ROOT, 'packages', 'myco-server'), ['src/**']), { stopAt: isLegacy });
  return { myco, server };
}
