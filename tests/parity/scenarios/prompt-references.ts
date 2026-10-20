import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';
import type { AttentionAnswer } from '@myco-server-worker/core/attention.js';

/** Needs you reads the same stored parse progress, reference kinds and ask sample on both stores. */
export const promptReferences: ParityScenario = {
  name: 'prompt references: attention excludes in-flight asks and reports missing prompts, mismatches and per-agent shares',
  dedicated: { timeoutMs: 60_000 },
  async run(target) {
    const project = lit(target.projectId);
    const now = Date.now();
    const read = async () => {
      const response = await fetch(`${target.url}/api/attention`, { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const answer = await response.json() as AttentionAnswer;
      expect(answer.unavailable).not.toContain('prompt_references');
      return answer.items.find(item => item.kind === 'prompt_references');
    };
    expect(await read()).toBeUndefined();
    await target.sql(`INSERT INTO sessions(project_id,session_id,agent,machine_id,created_by_token_id,first_received_at,last_received_at)
      VALUES (${project},'identity-s','codex','m','t',1,1)`);
    await target.sql(`INSERT INTO transcripts(project_id,transcript_id,session_id,machine_id,agent,size,parsed_offset,first_received_at,last_received_at,token_id,role,parsed_through_at,prompt_identity_scheme)
      VALUES (${project},'identity-tx','identity-s','m','codex',100,50,1,1,'t','primary',${now},'codex-turn-v1')`);
    await target.sql(`INSERT INTO spore_injections(project_id,id,session_id,prompt_id,prompt_hash,spore_ids,ask_protocol,asked_at,created_at,delivered_prompt_id,delivered_at)
      VALUES (${project},'identity-r','identity-s','identity-p','ask','[]','v1',${now-100},${now},'identity-p',${now-50})`);
    await target.sql(`INSERT INTO prompt_context_answers(project_id,id,session_id,prompt_id,ask_protocol,asked_at,created_at,outcome,context_chars,parts,skipped,failures,selection,delivered_prompt_id,delivered_at)
      VALUES (${project},'identity-a','identity-s','identity-p','v1',${now-100},${now},'served',1,'[]','[]','[]','{}','identity-p',${now-50})`);
    expect(await read()).toBeUndefined();
    await target.sql(`UPDATE transcripts SET parsed_offset=size WHERE project_id=${project} AND transcript_id='identity-tx'`);
    expect(await read()).toMatchObject({ total: 4, dangling: { receipt_selected: 1, answer_selected: 1, receipt_delivered: 1, answer_delivered: 1 } });
    await target.sql(`INSERT INTO prompt_batches(project_id,prompt_id,session_id,event_id,origin,content_hash,prompt_key_hash,created_at,updated_at,token_id,received_at)
      VALUES (${project},'identity-p','identity-s','identity-e','user','h','different',1,1,'t',1)`);
    await target.sql(`INSERT INTO prompt_context_answers(project_id,id,session_id,prompt_id,scope_reason,ask_protocol,asked_at,created_at,outcome,context_chars,parts,skipped,failures,selection)
      VALUES (${project},'identity-scoped','identity-s',NULL,'steering','v1',${now-100},${now},'served',1,'[]','[]','[]','{}'),
      (${project},'identity-legacy','identity-s','legacy-p',NULL,'legacy',NULL,${now},'served',1,'[]','[]','[]','{}')`);
    expect(await read()).toMatchObject({ total: 0, agents: [{ agent: 'codex', asks: 3, sessionScoped: 1, scopeReasons: { steering: { asks: 1, share: 1/3 } }, legacy: 1, sessionScopedShare: 1/3, legacyShare: 1/3, keyMismatches: 1 }] });
    await target.sql(`UPDATE prompt_batches SET prompt_key_hash='ask' WHERE project_id=${project} AND prompt_id='identity-p'`);
    expect(await read()).toBeUndefined();
  },
};
