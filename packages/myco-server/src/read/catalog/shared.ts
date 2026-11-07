import type { RelationalStore as sessions_import_RelationalStore } from "../../core/adapters.js";

async function queryRows<T extends Record<string, unknown>>(db: sessions_import_RelationalStore, sql: string, values: readonly unknown[], method: 'first'|'all'='all'): Promise<T[]> {
 const stmt=db.prepare(sql).bind(...values);
 if(method==='all')return (await stmt.all<T>()).results;
 const row=await stmt.first<T>();return row===null?[]:[row];
}

export { queryRows };
