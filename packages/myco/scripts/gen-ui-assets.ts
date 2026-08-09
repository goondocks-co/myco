import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const UI_DIR = path.resolve(PACKAGE_ROOT, 'dist/ui');
const OUTPUT_PATH = path.resolve(PACKAGE_ROOT, 'src/ui-assets.generated.ts');

const ENTRY_FILE = 'index.html';
const PUBLIC_DIR = path.resolve(PACKAGE_ROOT, 'ui/public');

/**
 * File extensions whose contents are text and may reference other assets by
 * their (content-hashed, unique) filename. Everything else — fonts, images —
 * is a leaf: it can be referenced but never references.
 */
const REFERENCING_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.svg', '.json', '.webmanifest', '.txt']);

/**
 * Recursively walk a directory, returning every file's path relative to the
 * walk root, using forward slashes (the keys callers look up at serve time).
 */
function walkFiles(root: string, dir: string = root): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(root, abs));
    } else if (entry.isFile()) {
      out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Return the subset of `files` that is neither copied from `ui/public/` nor
 * reachable from the entry file — i.e. stale build artifacts.
 *
 * Two-part trust model, mirroring where dist/ui content comes from:
 *
 * 1. Files whose relative path exists in `ui/public/` are trusted verbatim.
 *    Vite copies public/ into dist/ui unchanged; those files are deliberate,
 *    source-controlled additions and may be addressed by runtime-constructed
 *    paths (`/favicon-${theme}.svg`) that no static scan can see.
 * 2. Everything else is Vite-emitted output and must be reachable from
 *    index.html. Reachability is a breadth-first fixpoint over literal
 *    filename mentions: Vite emits content-hashed basenames
 *    (`index-Dy3Si9wF.js`), and every consumer — index.html script/link
 *    tags, dynamic-import specifiers inside minified JS, `url()` in CSS —
 *    contains that basename verbatim, so a file is referenced iff its
 *    basename appears in the text of a reached file.
 *
 * This guard exists because the embed step used to trust `dist/ui` blindly:
 * a leftover chunk from a previous build (interrupted build, older checkout,
 * second writer into the out-of-root dist dir) was embedded, committed, and
 * shipped 2.2MB of dead weight in every binary. Whatever puts a stale file in
 * `dist/ui`, it fails HERE — at the consumption point — instead of silently
 * bloating the bundle. A stale hashed chunk can satisfy neither branch: it is
 * never in public/, and nothing current references its hash.
 */
export function findStaleAssets(root: string, files: string[], publicDir: string): string[] {
  if (!files.includes(ENTRY_FILE)) {
    return [];
  }
  const reached = new Set<string>([ENTRY_FILE]);
  for (const file of files) {
    if (fs.existsSync(path.join(publicDir, file))) {
      reached.add(file);
    }
  }
  const queue = [ENTRY_FILE];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (!REFERENCING_EXTENSIONS.has(path.extname(current).toLowerCase())) {
      continue;
    }
    const content = fs.readFileSync(path.join(root, current), 'utf-8');
    for (const candidate of files) {
      if (reached.has(candidate)) continue;
      if (content.includes(path.posix.basename(candidate))) {
        reached.add(candidate);
        queue.push(candidate);
      }
    }
  }
  return files.filter((file) => !reached.has(file));
}

function readUiAssetMap(): Record<string, string> {
  if (!fs.existsSync(UI_DIR)) {
    process.stderr.write(
      `[gen-ui-assets] WARNING: ${path.relative(PACKAGE_ROOT, UI_DIR)} is absent — emitting empty map. ` +
        `Run \`npm run build:ui\` before codegen to embed the dashboard.\n`,
    );
    return {};
  }
  const files = walkFiles(UI_DIR);
  const stale = findStaleAssets(UI_DIR, files, PUBLIC_DIR);
  if (stale.length > 0) {
    throw new Error(
      `[gen-ui-assets] ${path.relative(PACKAGE_ROOT, UI_DIR)} contains ${stale.length} file(s) that are not copied ` +
        `from ui/public/ and that nothing reachable from ${ENTRY_FILE} references:\n` +
        stale.map((file) => `  - ${file}`).join('\n') +
        `\nThis is almost always a stale artifact from a previous build left in dist/ui. ` +
        `Delete dist/ui, rerun the UI build (\`npm run build:ui\`), then rerun codegen. ` +
        `Embedding it would ship dead weight in every compiled binary, so this build refuses.`,
    );
  }
  return Object.fromEntries(
    files.map((rel) => [rel, fs.readFileSync(path.join(UI_DIR, rel)).toString('base64')]),
  );
}

function main(): void {
  const assets = readUiAssetMap();

  const output = `// AUTO-GENERATED by scripts/gen-ui-assets.ts — DO NOT EDIT.
// Run \`npm run codegen\` to regenerate.
//
// Dashboard UI bundle (from \`dist/ui/\`) base64-encoded and bundled into code
// for the Bun-compiled binary path. The standalone binary ships without an
// adjacent \`dist/ui/\` tree, so it cannot rely on runtime filesystem reads;
// keys are file paths relative to \`dist/ui/\` (forward slashes, no leading
// slash) and values are base64 strings.

export const BUNDLED_UI: Readonly<Record<string, string>> = ${JSON.stringify(assets, null, 2)} as const;
`;

  fs.writeFileSync(OUTPUT_PATH, output, 'utf-8');
  process.stdout.write(
    `[gen-ui-assets] wrote ${path.relative(PACKAGE_ROOT, OUTPUT_PATH)} (${Object.keys(assets).length} files)\n`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
