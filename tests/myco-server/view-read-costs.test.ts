import {expect,it} from 'bun:test';
import {COST_MATERIALS,convertedLegacyHistory,legacyArmPlanViolations,partitionLegacyPlan,captureProbePlan,armPlanViolations,viewSourceArmPlans} from './helpers/view-read-costs.js';

for(const material of COST_MATERIALS.filter(value=>value.table!=='plans'))it(
 'converted-session '+material.table+' freezes its H_legacy term until PR 8 cleanup',
 ()=>convertedLegacyHistory(material),180_000);

it('plan identity excludes only cost estimates and rejects access-plan drift',()=>{
 const baseline=[{id:10,parent:0,notused:0,detail:'SEARCH p USING INDEX idx_prompt_batches_session (project_id=? AND session_id=?)'}];
 const publication=[{id:50,parent:0,detail:'SEARCH session_views USING INDEX key (project_id=? AND session_id=?)'}];
 expect(armPlanViolations({baseline,legacy:[{...baseline[0]!,id:99,notused:-15}],publication,view:[]})).toEqual([]);
 const drift=[{...baseline[0]!,detail:'SCAN p'}];
 expect(armPlanViolations({baseline,legacy:drift,publication,view:[]})).toContain('legacy arm differs from frozen plan');
 expect(baseline[0]!.notused).toBe(0);
});

it('source-arm budgets retain instance drivers and reject scans and missing source keys',()=>{
 const query={sql:'WITH prompt_batches AS NOT MATERIALIZED (SELECT 1 FROM main.prompt_batches f UNION ALL SELECT 2 FROM json_each(?2) j CROSS JOIN view_prompts v UNION ALL SELECT 3 FROM json_each(?3) j CROSS JOIN view_prompts v) SELECT * FROM prompt_batches',binds:['[]','["live"]','["parent"]']};
 const plan=[{id:1,parent:0,detail:'CO-ROUTINE prompt_batches'},{id:2,parent:1,detail:'COMPOUND QUERY'},
  {id:3,parent:2,detail:'LEFT-MOST SUBQUERY'},{id:4,parent:3,detail:'SEARCH f USING INDEX fact (project_id=? AND session_id=?)'},
  {id:5,parent:2,detail:'UNION ALL'},{id:6,parent:5,detail:'SCAN j VIRTUAL TABLE INDEX 1:'},
  {id:7,parent:5,detail:'SEARCH v USING INDEX idx_view_prompts_session (project_id=? AND instance_id=?)'},
  {id:8,parent:2,detail:'UNION ALL'},{id:9,parent:8,detail:'SCAN j VIRTUAL TABLE INDEX 1:'},
  {id:10,parent:8,detail:'SEARCH v USING INDEX idx_view_prompts_session (project_id=? AND instance_id=?)'}];
 const bound={instances:2,rowsPerInstance:5,survivingFacts:1};
 const check=(rows:typeof plan)=>viewSourceArmPlans(query,rows,bound);
 const source=check(plan);expect(source.errors).toEqual([]);expect(source.arms[0]!.outputBound).toBe(11);
 expect(source.arms[0]!.budgets.filter(([id])=>id===6||id===9)).toEqual([[6,{bound:2,maximum:2}],[9,{bound:2,maximum:2}]]);
 const unrelated={sql:query.sql.replace('SELECT * FROM prompt_batches','SELECT *,?4 AS extra,?5 AS ordinary FROM prompt_batches'),binds:[...query.binds,JSON.stringify(Array.from({length:500},(_,index)=>'unrelated-'+index)),'[not-json']};
 const isolated=viewSourceArmPlans(unrelated,plan,bound);expect(isolated.errors).toEqual([]);
 expect(isolated.arms[0]!.budgets.filter(([id])=>id===6||id===9)).toEqual([[6,{bound:2,maximum:2}],[9,{bound:2,maximum:2}]]);
 const excess={...query,binds:[query.binds[0]!,JSON.stringify(Array.from({length:400},(_,index)=>'instance-'+index)),query.binds[2]!]};
 expect(viewSourceArmPlans(excess,plan,bound).errors).toContain('instance driver exceeds declared visible-instance bound');
 const nested={...excess,sql:excess.sql.replace('json_each(?2)','json_each(json(?2))')};
 expect(viewSourceArmPlans(nested,plan,bound).errors).toContain('source driver has unknown provenance');
 for(const call of ['json_each (','json_each /* source */ (','\"json_each\"('])expect(viewSourceArmPlans({...nested,sql:nested.sql.replace('json_each(json(?2))',call+'json(?2))')},plan,bound).errors).toContain('source driver has unknown provenance');
 for(const alias of ['AS j','AS \"j\"','AS `j`','AS [j]'])expect(viewSourceArmPlans({...nested,sql:nested.sql.replace(')) j CROSS JOIN', ')) '+alias+' CROSS JOIN')},plan,bound).errors).toContain('source driver has unknown provenance');
 expect(viewSourceArmPlans({...excess,sql:excess.sql.replace('CROSS JOIN view_prompts v','CROSS JOIN view_prompts AS v')},plan,bound).errors).toContain('source driver has unknown provenance');
 expect(viewSourceArmPlans({...nested,sql:nested.sql.replace('CROSS JOIN view_prompts v','CROSS JOIN view_prompts AS v')},plan,bound).errors).toContain('source driver has unknown provenance');
 expect(viewSourceArmPlans({...nested,sql:nested.sql.replace('CROSS JOIN view_prompts','CROSS JOIN main.view_prompts')},plan,bound).errors).toContain('source driver has unknown provenance');
 const repeated=JSON.stringify(Array.from({length:400},()=>({projectId:'project',sessionId:'session',instanceId:'live'})));
 expect(viewSourceArmPlans({...query,binds:[query.binds[0]!,repeated,query.binds[2]!] },plan,bound).errors).toContain('source driver repeats a canonical entry');
 const factDriver={...query,sql:query.sql.replace('SELECT 1 FROM main.prompt_batches f','SELECT 1 FROM json_each(?1) j CROSS JOIN main.prompt_batches f'),binds:[JSON.stringify(Array.from({length:400},()=>({projectId:'project',sessionId:'session'}))),query.binds[1]!,query.binds[2]!]};
 expect(viewSourceArmPlans(factDriver,plan,bound).errors).toContain('source driver repeats a canonical entry');
 expect(check(plan.map(row=>row.id===7?{...row,detail:'SCAN v'}:row)).errors.length).toBeGreaterThan(0);
 expect(check(plan.map(row=>row.id===7?{...row,detail:'SEARCH v USING INDEX view_rows (project_id=?)'}:row)).errors.length).toBeGreaterThan(0);
 expect(check([...plan.slice(0,5),plan[6]!,plan[5]!,...plan.slice(7)]).errors).toContain('JSON driver follows its material loop');
 expect(check([...plan,{id:11,parent:1,detail:'USE TEMP B-TREE FOR ORDER BY'}]).errors.length).toBeGreaterThan(0);
 expect(check([...plan,{id:11,parent:1,detail:'SCAN winner'}]).errors.length).toBeGreaterThan(0);
});

it('plan comparison retains SELECT labels and rejects unclassified carrier shapes',()=>{
 const original='SELECT (SELECT prompt_id FROM prompt_batches), (SELECT response_id FROM responses)';
 const baseline=[{id:10,parent:0,detail:'SCAN CONSTANT ROW'},{id:11,parent:0,detail:'SCALAR SUBQUERY 1'},
  {id:12,parent:11,detail:'SCAN prompt_batches'},{id:13,parent:0,detail:'SCALAR SUBQUERY 2'},{id:14,parent:13,detail:'SCAN responses'}];
 const sql='/*vs:M01:turns_listTurns:0*/'+original;
 const input={original,sql,operation:'M01:turns_listTurns:0',baseline,candidate:baseline};
 expect(legacyArmPlanViolations(input)).toEqual([]);
 const swapped=baseline.map(row=>({...row,detail:row.detail==='SCALAR SUBQUERY 1'?'SCALAR SUBQUERY 2':row.detail==='SCALAR SUBQUERY 2'?'SCALAR SUBQUERY 1':row.detail}));
 expect(legacyArmPlanViolations({...input,candidate:swapped})).toContain('legacy arm differs from frozen plan');
 expect(()=>legacyArmPlanViolations({...input,sql:'/*vs:M01:turns_listTurns:0*/SELECT * FROM ('+original+') additional'})).toThrow('Legacy layout differs');
 const nested='SELECT legacy.* FROM (SELECT prompt_id FROM prompt_batches) legacy';
 const nestedPlan=[{id:1,parent:0,detail:'CO-ROUTINE legacy'},{id:2,parent:1,detail:'SCAN prompt_batches'},{id:3,parent:0,detail:'SCAN legacy'}];
 expect(partitionLegacyPlan({...input,original:nested,sql:'/*vs:M01:turns_listTurns:0*/'+nested,baseline:nestedPlan,candidate:nestedPlan}).legacy).toEqual(nestedPlan);
 for(const quoted of ["'SELECT OVER ( UNION )'",'`SELECT OVER`','[SELECT OVER]','"SELECT OVER"']){
  const value='SELECT '+quoted+' /* SELECT OVER ( UNION ) */ -- SELECT OVER\n FROM prompt_batches';
  expect(legacyArmPlanViolations({...input,original:value,sql:'/*vs:M01:turns_listTurns:0*/'+value,baseline:[],candidate:[]})).toEqual([]);
 }
 const window='SELECT ROW_NUMBER() OVER (ORDER BY prompt_id), (SELECT response_id FROM responses) FROM prompt_batches';
 expect(legacyArmPlanViolations({...input,original:window,sql:'/*vs:M01:turns_listTurns:0*/'+window,baseline:[],candidate:[]})).toEqual([]);
 expect(captureProbePlan(sql,[...baseline,{id:99,parent:0,detail:'SEARCH sv USING INDEX key (project_id=? AND session_id=?)'}]).errors).toContain('outer publication probe multiplicity differs');
 expect(captureProbePlan(sql,[...baseline,{id:99,parent:0,detail:'SCAN vv'}]).errors).toContain('unbounded vv capture: SCAN vv');
});
