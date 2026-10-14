import { deadlineBudget, type HookBudget } from '../member/budget.js';
import { observedFetch, runImport, type ImportDeps } from '../member/import.js';
import type { FetchLike } from '../member/transport.js';

const SIGNIN_CAPTURE_TIMEOUT_MS = 3_000;

interface SignInCapture {
  fetch: FetchLike;
  budget: HookBudget;
  signal: AbortSignal;
}

/** One deadline bounds all capture requests made while finishing sign-in. */
export async function withSignInCapture<T>(
  deps: { fetch?: FetchLike; now?: () => number; stdout: (line: string) => void },
  work: (capture: SignInCapture) => Promise<T>,
): Promise<T> {
  deps.stdout(`  Checking waiting capture (up to ${SIGNIN_CAPTURE_TIMEOUT_MS / 1000} seconds)…`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Sign-in capture deadline reached')), SIGNIN_CAPTURE_TIMEOUT_MS);
  try {
    return await work({
      fetch: observedFetch(deps.fetch ?? globalThis.fetch, { signal: controller.signal }).fetch,
      budget: { ...deadlineBudget((deps.now ?? Date.now)() + SIGNIN_CAPTURE_TIMEOUT_MS), signal: controller.signal, deferOnTimeout: true },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Import history within the sign-in window and report unfinished work. */
export async function importSignInHistory(
  opts: { serverUrl: string; project?: string },
  deps: Omit<ImportDeps, 'fetch' | 'signal'> & { stdout: (line: string) => void; stderr: (line: string) => void },
  capture: SignInCapture,
): Promise<void> {
  try {
    const report = await runImport({ ...opts, until: capture.budget.deadline }, { ...deps, fetch: capture.fetch, signal: capture.signal });
    const imported = report.projects.reduce((sum, project) => sum + project.agents.reduce((count, agent) => count + agent.imported, 0), 0);
    if (imported > 0) deps.stdout(`  Imported ${imported} past sessions. Run \`myco import\` to reach further back.`);
    const causes = report.projects.flatMap(project => Object.keys(project.causes ?? {}));
    const endings = report.projects.flatMap(project => project.endedBy === undefined ? [] : [project.endedBy]);
    const reason = report.refused ?? report.stoppedBy ?? [...new Set([...causes, ...endings])].join('; ');
    if (reason) deps.stderr(`  Past sessions are still waiting (${reason}); \`myco import\` retries them.`);
  } catch (error) {
    deps.stderr(`  Could not import past sessions (${(error as Error).message}); \`myco import\` retries them.`);
  }
}
