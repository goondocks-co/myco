import { machinePromptFileRoots } from '@myco/member/machine-settings.js';
import { runHelperVerb } from '@myco/cli/member-helper.js';
import { setAutomaticUpdates } from '@myco/member/automatic-update-state.js';
import { readAutomaticUpdatePreference } from '@myco/install/marker-reader.js';
import { REGISTRY_VERSION, writeRegistryEntry } from '@myco/member/registry.js';
import { MemberSpool } from '@myco/member/spool.js';
import { mintId, promptEvent, sessionStartEvent } from '@myco/member/envelope.js';
import type { ParityTarget } from '../harness.ts';

/** A member's delivery pass and local update command, using its isolated home and real transport. */
export function machineMember(target: ParityTarget, machine: { token: string; machineId: string; expiresAt: number }, home: string) {
  const route = { serverUrl: target.url, projectId: target.projectId };
  const paths: string[] = [];
  const spool = new MemberSpool(route, { mycoHome: home });
  writeRegistryEntry({ ...route, ...machine, version: REGISTRY_VERSION, root: home, joinedAt: Date.now(), updatedAt: Date.now() }, { mycoHome: home });
  let sessionId: string | undefined;
  const deliver = () => {
    paths.length = 0;
    return runHelperVerb(['--project', target.projectId, '--server', target.url, '--home', home], {
      lingerMs: 0, deadlineMs: 15_000, keepStderr: true, keepCurrent: () => null, spawn: () => ({ started: false }),
      fetch: (input, init) => {
        paths.push(new URL(input instanceof Request ? input.url : input).pathname);
        return fetch(input, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), 'cf-connecting-ip': '1.2.3.4' } });
      },
    });
  };
  return {
    pass: (deliveries = 1) => {
      for (let i = 0; i < deliveries; i++) {
        sessionId = crypto.randomUUID();
        spool.append(sessionId, sessionStartEvent({ agent: 'windsurf', sessionId, stage: spool.stagerFor(sessionId) }, { startedAt: Date.now() }));
      }
      return deliver();
    },
    prompt: () => {
      if (sessionId === undefined) throw new Error('Start the fixture session before its prompt.');
      spool.append(sessionId, promptEvent({ agent: 'windsurf', sessionId, stage: spool.stagerFor(sessionId) }, { promptId: mintId(), text: 'Continue the same task.' }));
      return deliver();
    },
    paths: () => [...paths],
    promptRoots: () => machinePromptFileRoots(target.url, home),
    automatic: () => readAutomaticUpdatePreference(home).enabled,
    localAutomatic: (enabled: boolean) => setAutomaticUpdates(home, enabled),
  };
}
