import fs from 'node:fs';
import path from 'node:path';
import { getMachineId } from '../machine-id.js';
import { HOOK_CONFIG } from '../hooks/hook-config.generated.js';
import { createPluginCaptureStore } from './plugin-capture-store.js';
import { routingKey, type MemberRoutingIdentity } from './routing.js';
import { readSessionState } from './session-state.js';
import type { MemberSpool } from './spool.js';
import { assertMemberPathContained, memberRoot } from './store.js';
import { transcriptPointerFor } from './transcript.js';
import { memberTranscriptScopeForPath, prepareMemberTranscriptScope } from './transcript-routing.js';

const FORMAT = 1;
interface CaptureScope { directory: string; agent: string; sessionId: string }

/** Recover retained plugin records through the same capability used by their producers. */
export function recoverPluginCapture(spool: MemberSpool, now: () => number, source?: { path: string; route: MemberRoutingIdentity; pendingRootKey: string }): { more: boolean } {
  const key = source === undefined ? (spool.routing === null ? null : routingKey(spool.routing))
    : memberTranscriptScopeForPath(source.path, source.route, spool.mycoHome, source.pendingRootKey);
  if (key === null) return { more: false };
  const claims = path.join(memberRoot(spool.mycoHome), 'claims', key);
  let entries: fs.Dirent[];
  try {
    assertMemberPathContained(claims, spool.mycoHome);
    entries = fs.readdirSync(claims, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { more: false };
    throw error;
  }
  const note = (_key: string, message: string) => process.stderr.write(`[myco] plugin capture: ${message}\n`);
  const transcript = (_directory: string, agent: string, sessionId: string) => path.join(memberRoot(spool.mycoHome), 'transcripts', key, agent, `${sessionId}.jsonl`);
  let store: ReturnType<typeof createPluginCaptureStore> | undefined;
  let more = false;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith('.lock.pending')) continue;
    const inbox = path.join(claims, entry.name);
    try {
      assertMemberPathContained(inbox, spool.mycoHome);
      const files = fs.readdirSync(inbox).filter(file => file.endsWith('.jsonl')).sort();
      if (files.length === 0) continue;
      let scope: CaptureScope | undefined;
      for (const file of files) {
        const source = path.join(inbox, file);
        assertMemberPathContained(source, spool.mycoHome);
        const text = fs.readFileSync(source, 'utf8');
        for (const line of text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean)) {
          let row: { _captureScope?: CaptureScope };
          try { row = JSON.parse(line); }
          catch (error) { note(source, `${source}: damaged pending line retained (${(error as Error).message})`); continue; }
          const candidate = row?._captureScope;
          if (candidate === undefined) continue;
          if (typeof candidate.directory !== 'string' || typeof candidate.agent !== 'string' || !Object.hasOwn(HOOK_CONFIG, candidate.agent)
            || typeof candidate.sessionId !== 'string' || !candidate.sessionId || /[/\\]/.test(candidate.sessionId)
            || entry.name !== `${candidate.agent}-${candidate.sessionId}.lock.pending`) throw new Error('Plugin inbox scope does not match its namespace');
          scope = candidate;
          break;
        }
        if (scope !== undefined) break;
      }
      if (scope === undefined) { note(inbox, `${inbox}: pending capture has no complete scope; retained for inspection`); continue; }
      if (spool.routing !== null && key === routingKey(spool.routing)) prepareMemberTranscriptScope(spool.routing, spool.mycoHome);
      const file = transcript(scope.directory, scope.agent, scope.sessionId);
      assertMemberPathContained(file, spool.mycoHome);
      store ??= createPluginCaptureStore({ note, home: () => spool.mycoHome, routing: () => key, transcript, format: FORMAT });
      if (!store.recoverInbox(scope.directory, scope.agent, scope.sessionId)) { more = true; continue; }
      const state = readSessionState(spool.dir, scope.sessionId);
      const pointer = transcriptPointerFor(file, getMachineId(), state.transcript);
      if (pointer === null) throw new Error('Recovered plugin transcript is unavailable');
      const size = fs.statSync(file).size;
      if (state.transcript?.transcriptId === pointer.transcriptId && pointer.nextOffset >= size) continue;
      spool.appendTurnEnd(scope.sessionId, { slot: 'primary', transcriptId: pointer.transcriptId, atSize: size }, next => {
        next.agent = scope!.agent;
        next.transcript = pointer;
        next.hookAt = now();
      }, now());
    } catch (error) { note(inbox, `${inbox}: recovery held; capture retained (${(error as Error).message})`); }
  }
  return { more };
}
