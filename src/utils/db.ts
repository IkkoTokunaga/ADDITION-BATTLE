import pg from 'pg';
import { neon } from '@neondatabase/serverless';

let queryFn: (text: string, params?: any[]) => Promise<{ rows: any[] }>;

const dbUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@127.0.0.1:5432/addition';

if (dbUrl.includes('neon.tech')) {
  // Use Neon's serverless HTTP API for stateless execution to prevent connection exhaustion.
  // Parameterized queries must go through sql.query(text, params); calling the tag
  // function directly with a plain string throws in @neondatabase/serverless v1.
  const sql = neon(dbUrl);
  queryFn = async (text: string, params?: any[]) => {
    const rows = await sql.query(text, params || []);
    return { rows: rows as any[] };
  };
} else {
  // Use standard pg Pool for local development.
  const pool = new pg.Pool({
    connectionString: dbUrl,
  });
  
  queryFn = async (text: string, params?: any[]) => {
    const result = await pool.query(text, params);
    return { rows: result.rows };
  };
}

/**
 * Executes a parameterized SQL query against the database.
 * TODO(security): Parameterized queries must be enforced for all SQL execution to prevent SQL Injection.
 */
export async function query(text: string, params?: any[]): Promise<{ rows: any[] }> {
  return queryFn(text, params);
}
