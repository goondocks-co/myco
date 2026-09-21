import { afterEach, expect, it } from 'bun:test';
import fs from 'node:fs';
import { listBufferSessionIds } from '@myco/capture/buffer.js';
import { promptEvent } from '@myco/member/envelope.js';
import { MemberSpool } from '@myco/member/spool.js';
import { tempMycoHome } from './helpers/server.js';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

it('retains an internal .jsonl segment in session IDs and reads its pending records', () => {
  const home = tempMycoHome();
  homes.push(home);
  const spool = new MemberSpool('proj_1', { mycoHome: home });
  const sessionId = 'a.jsonl.b';
  const event = promptEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), version: 'test' }, { promptId: 'prompt_1', text: 'example' });
  spool.append(sessionId, event);
  expect(listBufferSessionIds(spool.dir)).toEqual([sessionId]);
  expect(spool.readSpool()).toEqual({ readable: true, sessions: [{ sessionId, unacknowledged: 1 }] });
});
