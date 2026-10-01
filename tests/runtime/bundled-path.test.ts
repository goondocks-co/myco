/**
 * One rule for a path inside a compiled binary's own filesystem (`runtime/self-exec.ts` `isBundledPath`), read by every
 * caller that must tell such a path from a file on disk. A Windows build names its entry with forward slashes
 * (`B:/~BUN/root/<exe>`, observed on Bun 1.3.13); a caller with its own copy of the prefixes missed that form.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { loadAgentTasks } from '@myco/agent/loader.js';
import { BUNDLED_AGENT_PROMPTS, BUNDLED_AGENT_TASKS } from '@myco/agent/definitions.generated.js';
import { resolveOrchestratorPromptTemplate } from '@myco/agent/orchestrator.js';
import { resolveCliEntryPath } from '@myco/daemon/client.js';
import { selfExec } from '@myco/runtime/self-exec.js';

const BUNDLED_ROOTS = ['/$bunfs/root', 'B:\\~BUN\\root', 'B:/~BUN/root'];
const savedArgv1 = process.argv[1];
afterEach(() => { process.argv[1] = savedArgv1; });

describe('a path inside a compiled binary', () => {
  it('is no entry script for the daemon start, in every form a build reports', () => {
    for (const root of BUNDLED_ROOTS) {
      process.argv[1] = `${root}/myco.exe`;
      expect(resolveCliEntryPath()).toEqual({ execPath: process.execPath, cliEntry: null });
    }
    process.argv[1] = '/repo/packages/myco/src/entries/cli.ts';
    expect(resolveCliEntryPath().cliEntry).toBe('/repo/packages/myco/src/entries/cli.ts');
  });

  it('is no entry script for a helper\'s start (a project\'s, or the join bucket\'s), in every form a build reports', () => {
    for (const root of BUNDLED_ROOTS) {
      process.argv[1] = `${root}/myco.exe`;
      expect(selfExec()).toEqual({ path: process.execPath, args: [] });
    }
  });

  it('answers the agent definitions and the orchestrator prompt from what the binary carries, in every form', () => {
    expect(BUNDLED_AGENT_TASKS.length).toBeGreaterThan(0);
    const orchestrator = BUNDLED_AGENT_PROMPTS['orchestrator.md'];
    expect(orchestrator).toBeString();
    for (const root of BUNDLED_ROOTS) {
      expect(loadAgentTasks(`${root}/definitions`).map((task) => task.name)).toEqual(BUNDLED_AGENT_TASKS.map((task) => task.name));
      expect(resolveOrchestratorPromptTemplate(`${root}/agent`)).toBe(orchestrator);
    }
  });
});
