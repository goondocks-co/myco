import {expect} from 'bun:test';
import {budgetMigration} from '@myco-server-worker/db/budget-activation.js';
import {type ParityScenario} from '../harness.ts';

export const budgetMigrationParity:ParityScenario={
  name:'budget: populated schema upgrade keeps activation and its refusal visible',
  dedicated:{cloudflare:{latestSchemaUpgrade:true},timeoutMs:240_000},
  async run(target) {
    expect(await target.sql("SELECT COUNT(*) AS n FROM schema_meta WHERE key='budget_enabled_at'")).toEqual([{n:1}]);
    expect(await target.sql("SELECT COUNT(*) AS n FROM agent_runs WHERE status IN ('pending','running','queued') AND origin IS NULL")).toEqual([{n:0}]);
    await target.sql("DELETE FROM schema_meta WHERE key='budget_enabled_at'");
    await target.sql("DROP INDEX idx_attempts_claimed");
    await target.sql("INSERT OR REPLACE INTO schema_meta(key,value) VALUES('budget_activation_refusal','fixture: 100001 rows exceeds threshold 100000')");
    const inactive=await fetch(`${target.url}/api/status`,{headers:target.ownerHeaders()});
    expect(await inactive.json()).toMatchObject({budget:{active:false,reason:'fixture: 100001 rows exceeds threshold 100000'}});
    const complete=budgetMigration(Date.now());
    let next=complete.next();
    while(!next.done)next=complete.next(await target.sql(next.value.sql));
    expect(next.value).toEqual({active:true,reason:null});
    const active=await fetch(`${target.url}/api/status`,{headers:target.ownerHeaders()});
    expect(await active.json()).toMatchObject({budget:{active:true,reason:null}});
    expect(await target.sql("SELECT COUNT(*) AS n FROM schema_meta WHERE key='budget_activation_refusal'")).toEqual([{n:0}]);
  },
};
