import { expect } from 'bun:test';
import { sha256HexOf, uuidv5 } from '@myco-server-worker/hash.js';
import { documentsPublished, expectPersisted } from '../harness.ts';
import { event, owner, pick, type RouteTarget, type SeedTarget } from './requests.ts';

/** The sessions a Deployment's members captured, by the ids the product answered. */
export interface SessionsSeed {
  captured: { sessionId: string; promptIds: string[]; attachmentId: string; planKey: string };
  sibling: { sessionId: string; promptIds: string[] };
  transcript: { sessionId: string; promptIds: string[] };
  tombstoned: { sessionId: string };
  /** A word only the seeded records hold, for search. */
  word: string;
}

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0, 31, 21, 196, 137, 0, 0, 0, 13, 73, 68, 65, 84, 120, 156, 99, 96, 96, 96, 96, 0, 0, 0, 5, 0, 1, 165, 246, 69, 64, 0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130]);
const cursorLine = (role: string, text: string): string => `${JSON.stringify({ role, message: { content: [{ type: 'text', text }] } })}\n`;

async function blob(target: SeedTarget, bytes: Uint8Array<ArrayBuffer>, mediaType: string): Promise<string> {
  const digest = await sha256HexOf(bytes);
  await expectPersisted(await fetch(`${target.url}/blobs/${digest}`, {
    method: 'POST', headers: target.memberHeaders({ 'content-type': mediaType, 'content-length': String(bytes.byteLength) }), body: bytes,
  }), `${mediaType} blob`);
  return digest;
}

/**
 * Two sessions captured on one branch (prompts, a reply, a plan and a screenshot), a cursor transcript published into
 * a session document, and a session the owner tombstoned.
 */
export async function seedSessions(target: SeedTarget, stamp: number): Promise<SessionsSeed> {
  const word = `upgradeword${stamp}`;
  const captured = { sessionId: `upgrade-captured-${stamp}`, promptIds: [crypto.randomUUID(), crypto.randomUUID()], attachmentId: crypto.randomUUID(), planKey: '' };
  await event(target, captured.sessionId, 'session.start', { agent: 'claude-code', branch: 'upgrade', startedAt: stamp }, stamp);
  await event(target, captured.sessionId, 'prompt', { promptId: captured.promptIds[0], text: `Plan the upgrade ${word}`, origin: 'user' }, stamp + 1);
  await event(target, captured.sessionId, 'attachment', { attachmentId: captured.attachmentId, promptId: captured.promptIds[0], blob: await blob(target, PNG, 'image/png'), description: 'a screenshot' }, stamp + 2);
  await event(target, captured.sessionId, 'response', { responseId: crypto.randomUUID(), promptId: captured.promptIds[0], text: 'Planned it.' }, stamp + 3);
  await event(target, captured.sessionId, 'prompt', { promptId: captured.promptIds[1], text: 'and carry it out', origin: 'user' }, stamp + 4);
  const planPath = `docs/plans/upgrade-${stamp}.md`;
  captured.planKey = await uuidv5('plan', target.projectId, planPath);
  await event(target, captured.sessionId, 'plan', { planKey: captured.planKey, promptId: captured.promptIds[0], title: 'Upgrade', content: '- [x] seed\n- [ ] upgrade', originPath: planPath, status: 'active' }, stamp + 5);

  // An hour-old session, quiet enough for the learning work an end makes due.
  const earlier = stamp - 3_600_000;
  const sibling = { sessionId: `upgrade-sibling-${stamp}`, promptIds: [crypto.randomUUID()] };
  await event(target, sibling.sessionId, 'session.start', { agent: 'codex', branch: 'upgrade', startedAt: earlier }, earlier);
  await event(target, sibling.sessionId, 'prompt', { promptId: sibling.promptIds[0], text: 'Review the upgrade', origin: 'user' }, earlier + 1);
  await event(target, sibling.sessionId, 'tool.failure', { toolCallId: crypto.randomUUID(), promptId: sibling.promptIds[0], toolName: 'Bash', input: { command: 'upgrade --check' }, success: false, errorMessage: 'exit 1: schema behind' }, earlier + 2);
  await event(target, sibling.sessionId, 'response', { responseId: crypto.randomUUID(), promptId: sibling.promptIds[0], text: 'Apply the migrations before serving.' }, earlier + 3);

  const transcript = { sessionId: `upgrade-transcript-${stamp}`, promptIds: [] as string[] };
  const text = cursorLine('user', '<user_query>\nfirst question\n</user_query>') + cursorLine('assistant', 'first answer')
    + cursorLine('user', '<user_query>\nsecond question\n</user_query>') + cursorLine('assistant', 'second answer');
  const bytes = new TextEncoder().encode(text);
  await event(target, transcript.sessionId, 'transcript.segment', {
    transcriptId: `tx_${crypto.randomUUID().replaceAll('-', '')}`, baseOffset: 0, length: bytes.byteLength, blob: await blob(target, bytes, 'text/plain'), agent: 'cursor',
  }, stamp + 20);

  const tombstoned = { sessionId: `upgrade-tombstoned-${stamp}` };
  await event(target, tombstoned.sessionId, 'session.start', { agent: 'claude-code', branch: 'abandoned', startedAt: stamp + 30 }, stamp + 30);
  await event(target, tombstoned.sessionId, 'prompt', { promptId: crypto.randomUUID(), text: 'never mind', origin: 'user' }, stamp + 31);

  for (const sessionId of [captured.sessionId, sibling.sessionId, transcript.sessionId, tombstoned.sessionId]) await documentsPublished(target, sessionId);
  const removed = await owner(target, `/api/projects/${target.projectId}/sessions/${tombstoned.sessionId}/tombstone`, { method: 'POST', body: JSON.stringify({ reason: 'abandoned' }) });
  expect(removed.status).toBe(202);
  const turns = await owner(target, `/api/projects/${target.projectId}/sessions/${transcript.sessionId}/turns`);
  transcript.promptIds = (turns.body.rows as Array<{ promptId: string }>).map((row) => row.promptId);
  expect(transcript.promptIds.length).toBe(2);
  return { captured, sibling, transcript, tombstoned, word };
}

/** What members read of the seeded sessions: the Project's home and list, each session, its turns and their bodies, and search. */
export async function observeSessions(target: RouteTarget, seed: SessionsSeed): Promise<Record<string, unknown>> {
  const project = `/api/projects/${target.projectId}`;
  const session = async (sessionId: string, promptIds: string[]) => {
    const detail = await owner(target, `${project}/sessions/${sessionId}`);
    const turns = await owner(target, `${project}/sessions/${sessionId}/turns`);
    const bodies = await Promise.all(promptIds.map((promptId) => owner(target, `${project}/sessions/${sessionId}/turns/${promptId}`)));
    return {
      status: [detail.status, turns.status, ...bodies.map((body) => body.status)],
      session: pick(detail.body.session, ['sessionId', 'agent', 'branch', 'startedAt', 'memberId', 'label']),
      counts: pick(detail.body.counts, ['userPrompts', 'prompts', 'responses', 'plans', 'attachments']),
      spores: (detail.body.outcome?.spores?.items ?? []).map((spore: unknown) => pick(spore, ['id', 'status', 'agentLine'])),
      turns: (turns.body.rows ?? []).map((row: unknown) => pick(row, ['promptId', 'origin', 'preview', 'responseCount', 'planCount', 'attachmentCount'])),
      bodies: bodies.map(({ body }) => ({
        prompt: pick(body.prompt, ['promptId', 'text', 'origin']),
        responses: (body.responses ?? []).map((response: unknown) => pick(response, ['text'])),
        plans: (body.plans ?? []).map((plan: unknown) => pick(plan, ['planKey', 'title', 'status', 'content', 'progress'])),
        attachments: (body.attachments ?? []).map((attachment: unknown) => pick(attachment, ['attachmentId', 'promptId', 'mediaType'])),
      })),
    };
  };
  const seeded = new Set([seed.captured.sessionId, seed.sibling.sessionId, seed.transcript.sessionId, seed.tombstoned.sessionId]);
  const projects = await owner(target, '/api/projects');
  const activity = await owner(target, `${project}/activity`);
  const listed = await owner(target, `${project}/sessions`);
  return {
    home: [projects.status, pick((projects.body.projects ?? []).find((row: { projectId: string }) => row.projectId === target.projectId), ['projectId', 'sessionCount'])],
    activity: [activity.status, activity.body.stats],
    list: [listed.status, (listed.body.rows ?? []).filter((row: { sessionId: string }) => seeded.has(row.sessionId)).map((row: unknown) => pick(row, ['sessionId', 'branch', 'label']))],
    captured: await session(seed.captured.sessionId, seed.captured.promptIds),
    sibling: await session(seed.sibling.sessionId, seed.sibling.promptIds),
    transcript: await session(seed.transcript.sessionId, seed.transcript.promptIds),
    tombstoned: (await owner(target, `${project}/sessions/${seed.tombstoned.sessionId}`)).status,
  };
}
