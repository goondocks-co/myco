import path from 'node:path';
import { LegacyLedger } from '@myco/member/legacy-ledger.js';
import { writeDeploymentMembership } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { legacyFixtureHome } from './legacy-home.js';

/** First project's import is recorded; the second project or destination has no accepted history. */
export function cutoverAfterFirstProject(root: string, boundary: 'projects' | 'destinations') {
  const legacy = legacyFixtureHome(root, { skippedProject: true });
  const mycoHome = path.join(root, 'member-home');
  const destinations = boundary === 'projects'
    ? ['https://setup-a.invalid', 'https://setup-a.invalid'] as const
    : ['https://setup-a.invalid', 'https://setup-b.invalid'] as const;
  for (const serverUrl of new Set(destinations)) {
    writeDeploymentMembership({ serverUrl, token: 'fixture-member-bearer', machineId: 'machine_setup', joinedAt: 1, updatedAt: 1 }, { mycoHome });
  }
  const routes = legacy.projects.slice(0, 2).map((project, index) => ({ ...project, serverUrl: destinations[index]! }));
  const completed = routes[0]!;
  const pending = routes[1]!;
  const ledger = new LegacyLedger(mycoHome, completed.serverUrl, completed.id);
  ledger.append({ k: 'source', session: completed.sessionId, from: 'vault' }, { k: 'session', session: completed.sessionId }, { k: 'spore', id: `spore_${completed.id}` });
  const skippedProject = legacy.projects[2]!;
  const skips = new Set([skippedProject.id]);
  const skipped = new MemberSpool({ serverUrl: destinations[0], projectId: skippedProject.id }, { mycoHome });
  const skippedSessionId = 'setup-skipped-session';
  skipped.append(skippedSessionId, { envelope: {
    eventId: '00000000-0000-7000-8000-000000000001', sessionId: skippedSessionId,
    kind: 'prompt', createdAt: 1, channel: 'cli', producer: { adapter: 'claude-code', version: '2.0.0-test' },
    payload: { promptId: '00000000-0000-7000-8000-000000000002', text: 'Retain skipped capture', origin: 'user' },
  } });
  return { legacy, mycoHome, routes, skips, completed, pending, ledger, skipped, skippedSessionId };
}
