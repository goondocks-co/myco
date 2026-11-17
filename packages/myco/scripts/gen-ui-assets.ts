import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..');
const ENTRY_FILE = 'index.html';
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '../..');
const BUILD_COMMAND = 'npm run build:ui';

/**
 * One dashboard build to embed: where it was built, which files were copied in
 * rather than referenced, and the module it becomes.
 *
 * The binary ships the Deployment's dashboard, built by its own package into
 * its own `dist/`.
 */
export interface UiBundle {
  name: string;
  uiDir: string;
  publicDir: string;
  outputPath: string;
  exportName: string;
  /** How the module describes where its bytes came from. */
  origin: string;
  /**
   * Build outputs that are directives to a hosting platform rather than page
   * assets. A binary serving its own dashboard has no edge to read them, so
   * embedding them ships bytes that answer requests as an unknown media type.
   */
  exclude?: readonly string[];
}

export const SERVER_UI: UiBundle = {
  name: 'Deployment dashboard',
  uiDir: path.resolve(PACKAGE_ROOT, '..', 'myco-server', 'ui', 'dist'),
  publicDir: path.resolve(PACKAGE_ROOT, '..', 'myco-server', 'ui', 'public'),
  outputPath: path.resolve(PACKAGE_ROOT, 'src/server-ui-assets.generated.ts'),
  exportName: 'BUNDLED_SERVER_UI',
  origin: 'packages/myco-server/ui/dist/',
  exclude: ['_headers'],
};

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
 * Two-part trust model, mirroring where the build directory's content comes from:
 *
 * 1. Files whose relative path exists in `ui/public/` are trusted verbatim.
 *    Vite copies public/ into the build directory unchanged; those files are deliberate,
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
 * An embed step that trusts the build directory blindly ships its leftovers:
 * a leftover chunk from a previous build (interrupted build, older checkout,
 * second writer into the out-of-root dist dir) was embedded, committed, and
 * shipped 2.2MB of dead weight in every binary. Whatever puts a stale file in
 * the build directory, it fails HERE — at the consumption point — instead of silently
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

function readUiAssetMap(bundle: UiBundle): Record<string, string> {
  // An absent build fails here. An empty map compiles into a binary that serves
  // no dashboard, with nothing else in the build reporting it.
  if (!fs.existsSync(bundle.uiDir)) {
    throw new Error(
      `[gen-ui-assets] the ${bundle.name} build at ${path.relative(PACKAGE_ROOT, bundle.uiDir)} is absent. ` +
        `Run \`${BUILD_COMMAND}\` from the repository root.`,
    );
  }
  const files = walkFiles(bundle.uiDir);
  if (!files.includes(ENTRY_FILE)) {
    throw new Error(`[gen-ui-assets] the ${bundle.name} has no ${ENTRY_FILE}. Run \`${BUILD_COMMAND}\` from the repository root.`);
  }
  const stale = findStaleAssets(bundle.uiDir, files, bundle.publicDir);
  if (stale.length > 0) {
    throw new Error(
      `[gen-ui-assets] ${path.relative(PACKAGE_ROOT, bundle.uiDir)} contains ${stale.length} file(s) that are not copied ` +
        `from ui/public/ and that nothing reachable from ${ENTRY_FILE} references:\n` +
        stale.map((file) => `  - ${file}`).join('\n') +
        `\nThis is almost always a stale artifact from a previous build left in the build directory. ` +
        `Delete ${bundle.origin}, rerun the UI build (\`npm run build:ui\`), then rerun codegen. ` +
        `Embedding it would ship dead weight in every compiled binary, so this build refuses.`,
    );
  }
  const excluded = new Set(bundle.exclude ?? []);
  return Object.fromEntries(
    files
      .filter((rel) => !excluded.has(rel))
      .map((rel) => [rel, fs.readFileSync(path.join(bundle.uiDir, rel)).toString('base64')]),
  );
}

export function emitBundle(bundle: UiBundle): number {
  const assets = readUiAssetMap(bundle);

  const output = `// AUTO-GENERATED by scripts/gen-ui-assets.ts — DO NOT EDIT.
// Run \`${BUILD_COMMAND}\` from the repository root to regenerate.
//
// The ${bundle.name} (from \`${bundle.origin}\`) base64-encoded and bundled
// into code for the Bun-compiled binary path. The standalone binary ships
// without an adjacent build tree, so it cannot rely on runtime filesystem
// reads; keys are file paths relative to that build (forward slashes, no
// leading slash) and values are base64 strings.

export const ${bundle.exportName}: Readonly<Record<string, string>> = ${JSON.stringify(assets, null, 2)} as const;
`;

  const unchanged = fs.existsSync(bundle.outputPath) && fs.readFileSync(bundle.outputPath, 'utf-8') === output;
  if (!unchanged) atomicWrite(bundle.outputPath, output);
  process.stdout.write(
    `[gen-ui-assets] ${unchanged ? 'unchanged' : 'wrote'} ${path.relative(PACKAGE_ROOT, bundle.outputPath)} (${Object.keys(assets).length} files)\n`,
  );
  return Object.keys(assets).length;
}

function atomicWrite(destination: string, content: string): void {
  const staging = `${destination}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(staging, content, 'utf8');
    fs.renameSync(staging, destination);
  } finally { fs.rmSync(staging, { force: true }); }
}

/** Names and bytes both participate, including additions and deletions after a checkout. */
function fingerprint(inputs: readonly string[]): string {
  const hash = createHash('sha256');
  const visit = (file: string): void => {
    hash.update(file).update('\0');
    if (!fs.existsSync(file)) { hash.update('absent\0'); return; }
    if (fs.statSync(file).isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) {
        if (!['node_modules', 'dist', '.git'].includes(name)) visit(path.join(file, name));
      }
    } else { hash.update(fs.readFileSync(file)).update('\0'); }
  };
  inputs.forEach(visit);
  return hash.digest('hex');
}

const INPUTS = [
  path.join(REPO_ROOT, 'packages/myco-server/ui'),
  path.join(REPO_ROOT, 'packages/myco-shared/src'),
  path.join(REPO_ROOT, 'packages/myco-server/package.json'),
  path.join(REPO_ROOT, 'package-lock.json'),
  path.join(REPO_ROOT, 'scripts/ensure-deps.mjs'),
  path.join(REPO_ROOT, 'tsconfig.json'),
  fileURLToPath(import.meta.url),
];

/** Build and embed from source; the cache binds the inputs, emitted module and Vite output. */
export function prepareDashboard({ bundle = SERVER_UI, inputs = INPUTS, build = () => {
  execFileSync('npm', ['run', 'build:ui', '-w', '@goondocks/myco-server'], {
    cwd: REPO_ROOT, stdio: 'inherit', shell: process.platform === 'win32',
  });
} }: { bundle?: UiBundle; inputs?: readonly string[]; build?: () => void } = {}): void {
  const cache = `${bundle.outputPath}.inputs.json`;
  const source = fingerprint(inputs);
  const artifacts = () => fingerprint([bundle.outputPath, ...(
    fs.existsSync(bundle.uiDir) ? walkFiles(bundle.uiDir).map(file => path.join(bundle.uiDir, file)) : [bundle.uiDir]
  )]);
  const receipt = () => JSON.stringify({ source, artifacts: artifacts() });
  if (fs.existsSync(cache) && fs.existsSync(bundle.outputPath) && fs.existsSync(path.join(bundle.uiDir, ENTRY_FILE))
    && fs.readFileSync(cache, 'utf8') === receipt()) return;
  build();
  emitBundle(bundle);
  atomicWrite(cache, receipt());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  prepareDashboard();
}
