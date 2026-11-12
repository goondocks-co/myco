import { AsyncLocalStorage } from 'node:async_hooks';

import { inheritStoreContext } from '../../packages/myco-server/src/core/adapters.js';

import type { RelationalStore, PreparedStatement } from '../../packages/myco-server/src/core/adapters.js';

export interface StatementFrame {
  operation: string;
  phase: string;
  spanId?: string;
  parentSpanId?: string;
  exceptionId?: string;
  origin?: PreparationOrigin;
  captured?: boolean;
}

export type PreparationOrigin = {kind:'module';capture?:unknown;callers?:readonly string[];replay?:string} | {kind:'oracle';sha256:string} | {
 kind:'exception';id:string;file:string;owner:string;expression:string;phase:'W'|'P'|'H'|'T';relations?:readonly string[];
 callers?:readonly string[];callerKeys?:readonly string[];callerRelations?:readonly {callers:readonly string[];relations:readonly string[]}[];
 nonSql?:boolean;
};

const callers=new AsyncLocalStorage<readonly string[]>();

export interface RecordedStatement extends StatementFrame {
  statementId: string;
  sql: string;
  binds: readonly unknown[];
  method: 'first' | 'all' | 'run' | 'batch';
  rowsRead?: number;
  rowsWritten?: number;
  changes?:number;
  rowCount?:number;
  rows?:readonly unknown[];
  nativeMethod?:string;
  failed?: true;
}

export interface StatementEvent extends StatementFrame {
  kind: 'prepare' | 'bind' | 'execute';
  statementId: string;
  sql: string;
  binds: readonly unknown[];
  method?: RecordedStatement['method'];
  failed?: true;
}

function accounting(result: unknown, entry: RecordedStatement,captureRows=false): void {
  const envelope=typeof result==='object'&&result!==null&&'results'in result&&Array.isArray(result.results)?result.results:undefined;
  const rows=entry.method==='first'?(envelope===undefined?(result===null?[]:[result]):envelope.slice(0,1)):envelope??[];
  entry.rowCount=rows.length;
  if(captureRows)entry.rows=structuredClone(rows);
  if (typeof result !== 'object' || result === null || !('meta' in result)) return;
  const meta = result.meta;
  if (typeof meta !== 'object' || meta === null) return;
  if ('rows_read' in meta && typeof meta.rows_read === 'number') entry.rowsRead = meta.rows_read;
  if ('rows_written' in meta && typeof meta.rows_written === 'number') entry.rowsWritten = meta.rows_written;
  if ('changes' in meta && typeof meta.changes === 'number') entry.changes = meta.changes;
}

/** Records adapter calls, their originating spans and deferred completion. */
export function statementRecorder(db: RelationalStore, options: {
  accounting: 'native' | 'd1';
  captureRows?:boolean;
  context?: () => StatementFrame | undefined;
  prepared?: (event: StatementEvent) => void;
  event?: (event: StatementEvent) => void;
  bufferLimit?: number;
  before?: (entry: RecordedStatement) => void | Promise<void>;
  after?: (entry: RecordedStatement) => void | Promise<void>;
}) {
  const statements: RecordedStatement[] = [];
  const events: StatementEvent[] = [];
  const pending = new Set<Promise<unknown>>();
  let sequence = 0;
  type Held = { statement: PreparedStatement; sql: string; binds: readonly unknown[]; statementId: string; frame: StatementFrame };
  const retain = <T>(values:T[], value:T):void => {
    values.push(value);
    if(options.bufferLimit!==undefined && values.length>2*options.bufferLimit)values.splice(0,options.bufferLimit);
  };
  const emitEvent = (event:StatementEvent):void => {
    retain(events,event);
    try{options.event?.(event)}catch(error){event.failed=true;throw error}
  };
  const originals = new WeakMap<PreparedStatement, Held>();
  const originalKey = Symbol('recorded-statement');
  const isMarked = (statement: PreparedStatement): statement is PreparedStatement & {[originalKey]: Held} => originalKey in statement;
  const frame = (sql: string): StatementFrame => {
    const supplied = options.context?.()??nativeSpans.getStore();
    return supplied??{operation:'unclassified',phase:'unclassified'};
  };
  const begin = (held: Omit<Held,'statement'>, method: RecordedStatement['method']): RecordedStatement => {
    const entry: RecordedStatement = {...held.frame,statementId:held.statementId,sql:held.sql,binds:held.binds,method};
    retain(statements,entry);
    emitEvent({...entry,kind:'execute'});
    return entry;
  };
  const track = <T>(promise: Promise<T>): Promise<T> => {
    pending.add(promise);
    void promise.then(() => pending.delete(promise), () => pending.delete(promise));
    return promise;
  };
  const record = <T>(entry: RecordedStatement, run: () => Promise<T>): Promise<T> => track((async()=>{
    try {
      if(options.before)await options.before(entry);
      const result = await run();
      accounting(result, entry,options.captureRows);
      return result;
    } catch (error) {
      entry.failed = true;
      const event=events.find(event=>event.kind==='execute' && event.statementId===entry.statementId && event.method===entry.method);
      if(event)event.failed=true;
      throw error;
    } finally { if(options.after)await options.after(entry); }
  })());
  const observe = (held: Held): PreparedStatement => {
    const {statement,sql,binds,statementId,frame}=held;
    const wrapped = {
      ...(options.accounting === 'native' ? statement : {}),
      [originalKey]: held,
      bind: (...values: unknown[]) => {
        const event: StatementEvent={...frame,kind:'bind',statementId,sql,binds:values};
        emitEvent(event);
        try { return observe({...held,statement:statement.bind(...values),binds:values}); }
        catch(error){event.failed=true;throw error}
      },
      first: <T,>() => {
        const entry = begin(held, 'first');
        if (options.accounting === 'native') return record(entry, () => statement.first<T>());
        return record(entry, () => statement.all<T>()).then(result=>result.results[0] ?? null);
      },
      all: <T,>() => record(begin(held, 'all'), () => statement.all<T>()),
      run: () => record(begin(held, 'run'), () => statement.run()),
    };
    originals.set(wrapped, held);
    return wrapped;
  };
  const recorded: RelationalStore = {
    prepare: (sql: string) => {
      const current=frame(sql), statementId='statement-'+String(++sequence);
      const event: StatementEvent={...current,kind:'prepare',statementId,sql,binds:[]};
      emitEvent(event);
      try {
        options.prepared?.(event);
        return observe({statement:db.prepare(sql),sql,binds:[],statementId,frame:current});
      } catch(error){event.failed=true;throw error}
    },
    batch: (batch: PreparedStatement[]) => {
      const held = batch.map(statement => {
        const original = originals.get(statement) ?? (isMarked(statement) ? statement[originalKey] : undefined);
        if (original === undefined) throw new Error('Recorded batch requires statements from its own store');
        return original;
      });
      const entries = held.map(value => begin(value, 'batch'));
      return track((async()=>{
        try {
          if(options.before)for (const entry of entries)await options.before(entry);
          const results = await db.batch(held.map(value => value.statement));
          results.forEach((result, index) => accounting(result, entries[index]!,options.captureRows));
          return results;
        } catch (error) {
          for (const entry of entries) entry.failed = true;
          for (const event of events) if(event.kind==='execute' && entries.some(entry=>entry.statementId===event.statementId))event.failed=true;
          throw error;
        } finally { if(options.after)for (const entry of entries)await options.after(entry); }
      })());
    },
  };
  return {
    db: inheritStoreContext(db, recorded), statements, events,
    drain: async () => {
      const failures:unknown[]=[];
      while(pending.size)for(const result of await Promise.allSettled([...pending]))if(result.status==='rejected')failures.push(result.reason);
      if(failures.length)throw new AggregateError(failures,'Recorded deferred statements failed');
    },
    reset: () => {if(pending.size)throw new Error('Cannot reset a recorder with pending statements');statements.length=0;events.length=0;sequence=0;},
  };
}

export const handledRequestContext=new AsyncLocalStorage<{id:string|null;path:string}>();

export function observeHandledException(error:unknown):void {
 console.error(JSON.stringify({kind:'parity_handled_exception',...handledRequestContext.getStore(),error:error instanceof Error?error.stack:String(error)}));
}

const nativeSpans=new AsyncLocalStorage<StatementFrame>();

const clockInstants=new AsyncLocalStorage<number>();

export function observedClockInstant(): number | undefined { return clockInstants.getStore(); }

export function withObservedClock<T>(at:number|undefined,run:()=>T):T{return at===undefined?run():clockInstants.run(at,run);}

let spanSequence=0;

const spanObservers=new Set<(frame:StatementFrame)=>void>();

export function observeStatementSpans(observe:(frame:StatementFrame)=>void):()=>void{
 spanObservers.add(observe);return ()=>{spanObservers.delete(observe);};
}

export function withStatementSpan<T>(operation:string,phase:string,run:()=>T):T{
 const parent=nativeSpans.getStore();
 const frame:StatementFrame={operation,phase,spanId:'native-span-'+String(++spanSequence),...(parent?.spanId?{parentSpanId:parent.spanId}:{})};
 for(const observe of spanObservers)observe(frame);
 return nativeSpans.run(frame,run);
}

export interface ReadTrace {events:StatementEvent[];statements:RecordedStatement[];spans:StatementFrame[];constructors:StatementFrame[]}

function isFrame(value:unknown):value is StatementFrame{
 return typeof value==='object'&&value!==null&&'operation'in value&&typeof value.operation==='string'&&'phase'in value&&typeof value.phase==='string';
}

function isStatement(value:unknown):value is RecordedStatement{
 return isFrame(value)&&'statementId'in value&&typeof value.statementId==='string'&&'sql'in value&&typeof value.sql==='string'&&'binds'in value&&Array.isArray(value.binds)&&'method'in value&&['first','all','run','batch'].some(method=>method===value.method);
}

function isEvent(value:unknown):value is StatementEvent{
 return isFrame(value)&&'statementId'in value&&typeof value.statementId==='string'&&'sql'in value&&typeof value.sql==='string'&&'binds'in value&&Array.isArray(value.binds)&&'kind'in value&&['prepare','bind','execute'].some(kind=>kind===value.kind);
}

export function decodeReadTrace(records:readonly unknown[]):ReadTrace{
 const trace:ReadTrace={events:[],statements:[],spans:[],constructors:[]};
 for(const row of records){
  if(typeof row!=='object'||row===null||!('kind'in row))throw new Error('Invalid Worker read observation');
  if(row.kind==='view_read_event'&&'event'in row&&isEvent(row.event))trace.events.push(row.event);
  else if(row.kind==='view_read_statement'&&isStatement(row))trace.statements.push(row);
  else if(row.kind==='view_read_span'&&isFrame(row))trace.spans.push(row);
  else if(row.kind==='view_read_constructor'&&isFrame(row))trace.constructors.push(row);
  else throw new Error('Unclassified Worker read observation');
 }
 return trace;
}
