// The self-hosted image's build inputs, checked without building the image: each stage that copies from the build
// context gets exactly the files its COPY lines bring in (less .dockerignore), and its bundling commands run there.
import fs from 'node:fs';
import path from 'node:path';
import { RUNNER_REMOVED_DASHBOARD_PACKAGES } from './ensure-deps.mjs';

/** A Dockerfile's stages: their working directory, context copies, stage copies and RUN commands, in order. */
export function dockerStages(text) {
  const stages = [];
  const joined = text.replace(/\\\r?\n/g, ' ').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith('#'));
  for (const line of joined) {
    const [instruction, ...rest] = line.split(/\s+/);
    const keyword = instruction.toUpperCase();
    if (keyword === 'FROM') {
      const name = line.match(/\bAS\s+(\S+)\s*$/i)?.[1] ?? String(stages.length);
      stages.push({ name, workdir: '/', instructions: [] });
      continue;
    }
    const stage = stages.at(-1);
    if (!stage) continue;
    if (keyword === 'WORKDIR') stage.workdir = path.posix.resolve(stage.workdir, rest.join(' '));
    else if (keyword === 'COPY') {
      const from = rest.find((word) => word.startsWith('--from='))?.slice('--from='.length);
      const words = rest.filter((word) => !word.startsWith('--'));
      const sources = words.slice(0, -1);
      stage.instructions.push({ kind: 'copy', from, sources, destination: path.posix.resolve(stage.workdir, words.at(-1)),
        intoDirectory: sources.length > 1 || words.at(-1).endsWith('/'), workdir: stage.workdir });
    } else if (keyword === 'RUN') stage.instructions.push({ kind: 'run', command: rest.join(' '), workdir: stage.workdir });
  }
  return stages;
}

/** The commands that bundle: a RUN that starts with `bun` or `npx`. Installs come from the checkout's install instead. */
const bundles = (command) => /^(?:bun|npx)\s/.test(command);

function ignoredBy(patterns, file) {
  return patterns.some((pattern) => {
    const bare = pattern.replace(/^\*\*\//, '');
    return file === bare || file.startsWith(`${bare}/`) || file.split('/').includes(bare);
  });
}

function copyInto(context, source, destination, ignore, toDirectory) {
  const absolute = path.join(context, source);
  if (!fs.existsSync(absolute)) throw new Error(`COPY ${source}: no such file in the build context`);
  if (fs.statSync(absolute).isDirectory()) {
    for (const entry of fs.readdirSync(absolute, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const file = path.relative(context, path.join(entry.parentPath, entry.name)).split(path.sep).join('/');
      if (ignoredBy(ignore, file)) continue;
      const target = path.join(destination, path.relative(absolute, path.join(entry.parentPath, entry.name)));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(context, file), target);
    }
  } else {
    const target = toDirectory ? path.join(destination, path.basename(source)) : destination;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(absolute, target);
  }
}

/**
 * The stage's own install, as `npm ci` would leave it: every package the checkout installed there, and the ones the test
 * runner removes from it (the dashboard's React copies) taken from the workspace install, where the runner leaves them.
 */
function linkInstall(modules, workspaceModules, destination) {
  fs.mkdirSync(destination, { recursive: true });
  // Scopes are directories of their own, so a package added to one never lands in the checkout's install.
  for (const name of fs.readdirSync(modules)) {
    const entries = name.startsWith('@') ? fs.readdirSync(path.join(modules, name)).map((child) => `${name}/${child}`) : [name];
    if (name.startsWith('@')) fs.mkdirSync(path.join(destination, name));
    for (const entry of entries) fs.symlinkSync(fs.realpathSync(path.join(modules, entry)), path.join(destination, entry), 'junction');
  }
  for (const name of RUNNER_REMOVED_DASHBOARD_PACKAGES) {
    const target = path.join(destination, name);
    if (fs.existsSync(target) || !fs.existsSync(path.join(workspaceModules, name))) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(fs.realpathSync(path.join(workspaceModules, name)), target, 'junction');
  }
}

/**
 * A `COPY --from=<stage>` source, judged against what that stage produced here. Present in its staging: produced. Named
 * in one of its RUN commands this check does not run, or the install an `npm ci` leaves: stated, but not known
 * statically, so it is reported as a note. Anything else: the stage does not produce it, and the image would not build.
 */
function judgeStageCopy(copy, stages, stageRoot) {
  const stage = stages.find((one) => one.name === copy.from);
  if (!stage) return copy.sources.map((source) => ({ note: `COPY --from=${copy.from} ${source}: another image, not known statically` }));
  return copy.sources.map((source) => {
    if (fs.existsSync(path.join(stageRoot(stage.name), source))) return {};
    const runs = stage.instructions.filter((one) => one.kind === 'run' && !bundles(one.command));
    const stated = runs.find((one) => one.command.split(/[\s&;|]+/).some((word) => word.replace(/\/$/, '') === source))
      ?? runs.find((one) => /^npm ci\b/.test(one.command) && source === path.posix.join(one.workdir, 'node_modules'));
    if (stated) return { note: `COPY --from=${copy.from} ${source}: made by RUN ${stated.command}, which this check does not run; not known statically` };
    return { problem: `COPY --from=${copy.from} ${source}: stage ${copy.from} does not produce it` };
  });
}

/**
 * Stages each image build stage under `scratch`, runs its bundling commands there, and checks every copy between stages.
 * Resolves with notes on what could not be known statically.
 * @param {{ context: string, dockerfile: string, scratch: string, run: Function, mirrorModules: Function }} input
 */
export async function imageInputs({ context, dockerfile, scratch, run, mirrorModules }) {
  const ignore = fs.existsSync(path.join(context, '.dockerignore'))
    ? fs.readFileSync(path.join(context, '.dockerignore'), 'utf8').split('\n').map((line) => line.trim()).filter((line) => line && !line.startsWith('#'))
    : [];
  const problems = [];
  const stages = dockerStages(fs.readFileSync(path.join(context, dockerfile), 'utf8'));
  for (const stage of stages) {
    const stageRoot = path.join(scratch, stage.name);
    const inside = (containerPath) => path.join(stageRoot, containerPath);
    const fromContext = stage.instructions.filter((one) => one.kind === 'copy' && !one.from);
    for (const copy of fromContext) {
      for (const source of copy.sources) {
        try { copyInto(context, source, inside(copy.destination), ignore, copy.intoDirectory); }
        catch (error) { problems.push(`${stage.name}: ${error.message}`); }
      }
    }
    const commands = stage.instructions.filter((one) => one.kind === 'run' && bundles(one.command));
    if (!commands.length) continue;
    // Dependencies: an install in this stage, or a node_modules taken from another stage, is the checkout's install.
    for (const one of stage.instructions) {
      if (one.kind === 'copy' && one.from && one.sources.some((source) => source.endsWith('/node_modules'))) {
        if (!fs.existsSync(inside(one.destination))) mirrorModules(path.join(context, 'node_modules'), inside(one.destination), inside(path.posix.join(one.workdir, 'packages')));
      }
      if (one.kind === 'run' && /^npm ci\b/.test(one.command)) {
        const manifest = fromContext.find((copy) => copy.workdir === one.workdir && copy.sources.some((source) => source.endsWith('package.json')));
        const directory = manifest && path.dirname(manifest.sources.find((source) => source.endsWith('package.json')));
        const modules = directory && path.join(context, directory, 'node_modules');
        const destination = inside(path.posix.join(one.workdir, 'node_modules'));
        if (modules && fs.existsSync(modules) && !fs.existsSync(destination)) linkInstall(modules, path.join(context, 'node_modules'), destination);
      }
    }
    for (const one of commands) {
      const command = one.command.replace(/(^|[\s=])(\/[\w./-]+)/g, (_, before, absolute) => `${before}'${inside(absolute)}'`);
      fs.mkdirSync(inside(one.workdir), { recursive: true });
      try { await run(command, [], { cwd: inside(one.workdir), shell: true }); }
      catch (error) {
        if (error.constructor?.name === 'Stop') throw error;
        problems.push(`${stage.name}: RUN ${one.command} failed with only the files the stage copies:\n${(error.output ?? error.message).trimEnd().split('\n').slice(-25).join('\n')}`);
      }
    }
  }
  const notes = [];
  for (const stage of stages) {
    for (const copy of stage.instructions.filter((one) => one.kind === 'copy' && one.from)) {
      for (const { note, problem } of judgeStageCopy(copy, stages, (name) => path.join(scratch, name))) {
        if (note) notes.push(`${stage.name}: ${note}`);
        if (problem) problems.push(`${stage.name}: ${problem}`);
      }
    }
  }
  if (problems.length) throw new Error([...problems, ...notes].join('\n'));
  return notes;
}
