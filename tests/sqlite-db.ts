import { DatabaseSync } from 'node:sqlite';
import type { Db } from '../src/memory';

/** Test adapter: node:sqlite behind the same interface the libSQL client satisfies. Keeps the raw handle for direct checks. */
export function sqliteDb(raw = new DatabaseSync(':memory:')): { db: Db; raw: DatabaseSync } {
  const db: Db = {
    async execute({ sql, args = [] }) {
      const st = raw.prepare(sql);
      if (/^\s*(SELECT|WITH)/i.test(sql)) {
        const objs = st.all(...args) as Record<string, any>[];
        const columns = objs.length ? Object.keys(objs[0]) : [];
        return { columns, rows: objs.map((o) => columns.map((c) => o[c])) };
      }
      const r = st.run(...args);
      return { columns: [], rows: [], lastInsertRowid: r.lastInsertRowid, rowsAffected: Number(r.changes) };
    },
  };
  return { db, raw };
}
