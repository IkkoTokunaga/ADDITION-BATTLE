import { neon } from '@neondatabase/serverless';
import pg from 'pg';

type QueryResult = { rows: any[] };
type QueryFn = (text: string, params?: any[]) => Promise<QueryResult>;

const dbUrl =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/addition';

let queryFn: QueryFn;

if (dbUrl.includes('neon.tech')) {
  // Neon serverless (production). Use sql.query() for parameterized queries.
  const sql = neon(dbUrl);
  queryFn = async (text, params) => {
    const rows = await sql.query(text, params || []);
    return { rows: rows as any[] };
  };
} else {
  // Local Postgres (Docker dev) via connection pool.
  const pool = new pg.Pool({ connectionString: dbUrl });
  queryFn = async (text, params) => {
    const result = await pool.query(text, params);
    return { rows: result.rows };
  };
}

export function query(text: string, params?: any[]): Promise<QueryResult> {
  return queryFn(text, params);
}
