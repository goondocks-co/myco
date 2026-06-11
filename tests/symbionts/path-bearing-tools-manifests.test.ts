import { describe, it, expect } from 'bun:test';
import { loadManifests } from '@myco/symbionts/detect.js';
import { extractAnyPath } from '@myco/symbionts/canopy-read-tools.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';

/**
 * Per-manifest extraction drift tests for `capabilities.pathBearingTools`.
 *
 * Every payload below is the REAL tool_input shape mined from live hook
 * buffers / the dogfood vault during the 2026-06-11 capture-fidelity smoke
 * runs (one session per symbiont). These tests exercise the actual YAML →
 * Zod → resolver chain, so editing a manifest in a way that breaks a
 * symbiont's path extraction fails here — not silently in production as
 * `activities.file_path = NULL`.
 */

function manifest(name: string): SymbiontManifest {
  const m = loadManifests().find((x) => x.name === name);
  expect(m).toBeDefined();
  return m!;
}

describe('claude-code pathBearingTools (reference behavior)', () => {
  it('extracts Read file_path', () => {
    expect(extractAnyPath(manifest('claude-code'), 'Read', {
      file_path: '/Users/chris/Repos/myco/README.md', limit: 15,
    })).toEqual({ filePath: '/Users/chris/Repos/myco/README.md' });
  });
  it('extracts Write file_path', () => {
    expect(extractAnyPath(manifest('claude-code'), 'Write', {
      file_path: '/tmp/smoke-v2-claude-code.txt', content: 'smoke-v2 claude-code verified',
    })).toEqual({ filePath: '/tmp/smoke-v2-claude-code.txt' });
  });
});

describe('cursor pathBearingTools', () => {
  // Smoke session 64465029…: the Read failure event arrived with
  // `agent: cursor` and `tool_input.file_path`, but cursor.yaml had no
  // pathBearingTools — so file_path stored NULL while the Write event
  // (mislabeled `agent: claude-code` by Cursor's embedded runtime)
  // extracted via the claude-code manifest.
  it('extracts Read file_path (the smoke-run failure case)', () => {
    expect(extractAnyPath(manifest('cursor'), 'Read', {
      file_path: '/tmp/smoke-v2-cursor.txt',
    })).toEqual({ filePath: '/tmp/smoke-v2-cursor.txt' });
  });
  it('extracts Write file_path', () => {
    expect(extractAnyPath(manifest('cursor'), 'Write', {
      file_path: '/tmp/smoke-v2-cursor.txt', content: 'smoke-v2 cursor verified',
    })).toEqual({ filePath: '/tmp/smoke-v2-cursor.txt' });
  });
  it('extracts Edit and Delete file_path', () => {
    expect(extractAnyPath(manifest('cursor'), 'Edit', { file_path: 'src/x.ts' }))
      .toEqual({ filePath: 'src/x.ts' });
    expect(extractAnyPath(manifest('cursor'), 'Delete', {
      file_path: '/Users/chris/Repos/myco/packages/myco/src/daemon/jobs/canopy-delta-scan.ts',
    })).toEqual({ filePath: '/Users/chris/Repos/myco/packages/myco/src/daemon/jobs/canopy-delta-scan.ts' });
  });
  it('extracts Grep file_path when scoped to one file, null for pattern-only', () => {
    expect(extractAnyPath(manifest('cursor'), 'Grep', {
      pattern: 'codex/settings.json',
      file_path: '/Users/chris/Repos/myco/packages/myco/src/symbionts/templates.generated.ts',
      output_mode: 'content',
    })).toEqual({ filePath: '/Users/chris/Repos/myco/packages/myco/src/symbionts/templates.generated.ts' });
    expect(extractAnyPath(manifest('cursor'), 'Grep', {
      pattern: 'upsertTomlSection', output_mode: 'files_with_matches',
    })).toBeNull();
  });
  it('extracts Shell cat-style reads, null for non-read commands', () => {
    expect(extractAnyPath(manifest('cursor'), 'Shell', {
      command: 'cat README.md', cwd: '', timeout: 30000,
    })).toEqual({ filePath: 'README.md' });
    expect(extractAnyPath(manifest('cursor'), 'Shell', {
      command: 'git log -1 --stat', cwd: '', timeout: 30000,
    })).toBeNull();
  });
});

describe('windsurf pathBearingTools', () => {
  it('extracts post_write_code file_path from the tool_info bag', () => {
    // Smoke session 028329ac…: tool_input is the `tool_info` bag with
    // `file_path` at top level alongside the edits array.
    expect(extractAnyPath(manifest('windsurf'), 'post_write_code', {
      edits: [{ old_string: '', new_string: 'smoke-v2 cascade verified' }],
      file_path: '/tmp/smoke-v2-cascade.txt',
    })).toEqual({ filePath: '/tmp/smoke-v2-cascade.txt' });
  });
  it('extracts post_run_command cat-style reads', () => {
    expect(extractAnyPath(manifest('windsurf'), 'post_run_command', {
      command: 'cat README.md',
    })).toEqual({ filePath: 'README.md' });
  });
  // Windsurf fires NO hook for file views (app-side limitation, documented
  // in windsurf.yaml) — there is deliberately no read-tool entry to test.
});

describe('pi pathBearingTools', () => {
  it('extracts read path', () => {
    expect(extractAnyPath(manifest('pi'), 'read', {
      path: 'README.md', offset: 1, limit: 40,
    })).toEqual({ filePath: 'README.md' });
  });
  it('extracts write path', () => {
    expect(extractAnyPath(manifest('pi'), 'write', {
      path: '/tmp/smoke-v2-pi.txt', content: 'smoke-v2 pi verified',
    })).toEqual({ filePath: '/tmp/smoke-v2-pi.txt' });
  });
  it('extracts edit path', () => {
    expect(extractAnyPath(manifest('pi'), 'edit', {
      path: 'scripts/one-shots/README.md', edits: [{ oldText: 'a', newText: 'b' }],
    })).toEqual({ filePath: 'scripts/one-shots/README.md' });
  });
  it('extracts bash cat-style reads, null otherwise', () => {
    expect(extractAnyPath(manifest('pi'), 'bash', { command: 'cat README.md', timeout: 20 }))
      .toEqual({ filePath: 'README.md' });
    expect(extractAnyPath(manifest('pi'), 'bash', { command: 'git status --short', timeout: 20 }))
      .toBeNull();
  });
});

describe('antigravity pathBearingTools', () => {
  it('extracts view_file AbsolutePath (current app, PascalCase args)', () => {
    expect(extractAnyPath(manifest('antigravity'), 'view_file', {
      AbsolutePath: '/Users/chris/repos/myco/README.md',
      EndLine: 20, StartLine: 1,
      toolAction: 'Viewing README.md first lines',
      toolSummary: 'Read README.md first lines',
    })).toEqual({ filePath: '/Users/chris/repos/myco/README.md' });
  });
  it('extracts write_to_file TargetFile (current app, PascalCase args)', () => {
    expect(extractAnyPath(manifest('antigravity'), 'write_to_file', {
      CodeContent: 'smoke-v2 antigravity verified\n',
      Description: 'Write verification smoke test file',
      Overwrite: true,
      TargetFile: '/tmp/smoke-v2-antigravity.txt',
      toolAction: 'Writing smoke test file',
      toolSummary: 'Create smoke-v2-antigravity.txt',
    })).toEqual({ filePath: '/tmp/smoke-v2-antigravity.txt' });
  });
  it('extracts Gemini-era read_file/replace file_path', () => {
    expect(extractAnyPath(manifest('antigravity'), 'read_file', {
      file_path: 'packages/myco/src/db/queries/sessions.ts',
    })).toEqual({ filePath: 'packages/myco/src/db/queries/sessions.ts' });
    expect(extractAnyPath(manifest('antigravity'), 'replace', {
      file_path: 'packages/myco/ui/src/components/mycelium/GraphCanvas.tsx',
      old_string: 'a', new_string: 'b',
    })).toEqual({ filePath: 'packages/myco/ui/src/components/mycelium/GraphCanvas.tsx' });
  });
  it('extracts run_shell_command cat-style reads', () => {
    expect(extractAnyPath(manifest('antigravity'), 'run_shell_command', {
      command: 'cat package.json', description: 'Inspect package',
    })).toEqual({ filePath: 'package.json' });
  });
});

describe('opencode pathBearingTools', () => {
  it('extracts read filePath (camelCase)', () => {
    // Smoke session ses_147807fe…: read carries BOTH filePath and file_path;
    // the manifest declares the camelCase field.
    expect(extractAnyPath(manifest('opencode'), 'read', {
      filePath: '/Users/chris/Repos/myco/README.md', offset: 1, limit: 40,
      file_path: '/Users/chris/Repos/myco/README.md',
    })).toEqual({ filePath: '/Users/chris/Repos/myco/README.md' });
  });
  it('extracts apply_patch path from the patchText envelope', () => {
    expect(extractAnyPath(manifest('opencode'), 'apply_patch', {
      patchText: '*** Begin Patch\n*** Add File: /tmp/smoke-v2-opencode.txt\n+smoke-v2 opencode verified\n*** End Patch',
    })).toEqual({ filePath: '/tmp/smoke-v2-opencode.txt' });
  });
  it('extracts bash cat-style reads', () => {
    expect(extractAnyPath(manifest('opencode'), 'bash', {
      command: 'cat packages/myco/package.json',
    })).toEqual({ filePath: 'packages/myco/package.json' });
  });
});

describe('codex pathBearingTools', () => {
  it('still extracts Bash shell-arg reads (no regression)', () => {
    expect(extractAnyPath(manifest('codex'), 'Bash', { command: "sed -n '1,5p' src/x.ts" }))
      .toEqual({ filePath: 'src/x.ts' });
  });
  it('extracts apply_patch path from the command envelope', () => {
    expect(extractAnyPath(manifest('codex'), 'apply_patch', {
      command: '*** Begin Patch\n*** Update File: docs/groves.md\n@@\n-old\n+new\n*** End Patch',
    })).toEqual({ filePath: 'docs/groves.md' });
  });
});

describe('pathBearingTools coverage drift', () => {
  it('every symbiont with observed path-bearing tool events declares the section', () => {
    // copilot already declared its section before this change; the
    // remaining manifests gained theirs from the 2026-06-11 smoke findings.
    const covered = ['claude-code', 'codex', 'copilot', 'cursor', 'windsurf', 'pi', 'antigravity', 'opencode'];
    for (const name of covered) {
      const tools = manifest(name).capabilities?.pathBearingTools ?? [];
      expect(tools.length).toBeGreaterThan(0);
    }
  });
  it('canopyReadTools entries are always mirrored in pathBearingTools (schema invariant)', () => {
    for (const m of loadManifests()) {
      const reads = m.capabilities?.canopyReadTools ?? [];
      const paths = m.capabilities?.pathBearingTools ?? [];
      if (reads.length > 0) expect(paths.length).toBeGreaterThan(0);
    }
  });
});
