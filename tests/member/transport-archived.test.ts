import { describe, expect, it } from 'bun:test';
import { classifyBlobAnswer, classifyEventAnswer, classifyRefreshAnswer } from '@myco/member/transport.js';

/** A 200 in the route's shape with the given body, carrying the server's protocol header as every post-authentication answer does. */
const answer = (json: Record<string, unknown>) => ({ kind: 'response' as const, status: 200, protocolHeader: true, json });

describe('an archived project, as the member reads it', () => {
  it('classifies the capture refusal as refused by its own name on both capture routes', () => {
    expect(classifyEventAnswer(answer({ persisted: false, code: 'project_archived', reason: 'archived' })))
      .toEqual({ class: 'refused', code: 'project_archived', reason: 'archived' });
    expect(classifyBlobAnswer(answer({ stored: false, code: 'project_archived', reason: 'archived' })))
      .toEqual({ class: 'refused', code: 'project_archived', reason: 'archived' });
  });

  it('never reads a refresh as refused for it: a rotated credential is a rotated credential', () => {
    const refreshed = classifyRefreshAnswer(answer({ refreshed: true, token: 'myco_' + 'a'.repeat(43), tokenId: 'mt_next', expiresAt: 10, refreshAfter: 5 }));
    expect(refreshed.class).toBe('refreshed');
  });
});
