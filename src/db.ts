import type { Db, DbResult } from './memory';

/** Opens the Turso/libSQL database from TURSO_DATABASE_URL / TURSO_AUTH_TOKEN. */
export async function openTurso(): Promise<Db> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('TURSO_DATABASE_URL is not set');
  const { createClient } = await import('@libsql/client');
  const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
  return {
    async execute(stmt): Promise<DbResult> {
      const rs = await client.execute({ sql: stmt.sql, args: stmt.args ?? [] });
      return {
        columns: rs.columns,
        rows: rs.rows,
        lastInsertRowid: rs.lastInsertRowid,
        rowsAffected: rs.rowsAffected,
      } as DbResult;
    },
  };
}
