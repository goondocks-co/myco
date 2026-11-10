import fs from 'node:fs';
import path from 'node:path';
import { rootSlug } from '@myco/symbionts/transcript-attribution.js';

/**
 * One finished Claude Code session in `<home>/.claude/projects`, recorded in `root`: the history a member import
 * offers to its Deployment. Aged past the freshness floor so the import reads it as history, not a live session.
 */
export function harnessHistory(home: string, root: string, sessionId = '00000000-0000-4000-8000-000000000001'): string {
  const dir = path.join(home, '.claude', 'projects', `-${rootSlug(root)}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sessionId}.jsonl`);
  const line = (o: Record<string, unknown>) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(file, line({ type: 'user', cwd: root, promptId: '00000000-0000-7000-8000-000000000001', message: { content: `prompt ${'x'.repeat(5000)}` }, timestamp: '2026-09-01T10:00:00Z' })
    + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply' }] }, timestamp: '2026-09-01T10:00:01Z' }));
  const at = new Date(Date.now() - 60 * 60_000);
  fs.utimesSync(file, at, at);
  return file;
}

/** Point HOME at `home` for the harness stores a member reads; the returned call restores it. */
export function withHarnessHome(home: string): () => void {
  const held = process.env.HOME;
  process.env.HOME = home;
  return () => { if (held === undefined) delete process.env.HOME; else process.env.HOME = held; };
}

export type FakeAnswer = Response | ((request: Request) => Response | Promise<Response>);

/**
 * A Deployment as a member's injected fetch sees it: each route answers from `routes` (by pathname), anything else
 * answers 404, and every request is recorded by pathname in `requests`, in arrival order.
 */
export function fakeDeployment(routes: Record<string, FakeAnswer> = {}) {
  const requests: string[] = [];
  const answers = { ...routes };
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const route = new URL(request.url).pathname;
    requests.push(route);
    const answer = answers[route];
    if (answer === undefined) return new Response('{}', { status: 404 });
    return typeof answer === 'function' ? answer(request) : answer.clone();
  };
  return { fetch, requests, answers, count: (route: string) => requests.filter(r => r === route).length };
}
