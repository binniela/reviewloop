import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Minimal database surface. Postgres in production (Supabase), PGlite in tests and local dev. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

export async function migrate(db: Db): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
  const ran: string[] = [];
  // Serialize deploys and make each schema change plus its ledger entry atomic. A failed
  // migration rolls back instead of leaving half-applied DDL on a live Postgres database.
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(790287316)");
    await tx.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await tx.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      await execScript(tx, sql);
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
      ran.push(file);
    }
  });
  return ran;
}

// Both drivers accept multi-statement scripts only through their simple-query paths.
async function execScript(db: Db, sql: string) {
  const anyDb = db as Db & { exec?: (sql: string) => Promise<void> };
  if (anyDb.exec) return anyDb.exec(sql);
  await db.query(sql);
}

export async function openPglite(dataDir?: string): Promise<Db & { exec(sql: string): Promise<void> }> {
  const { PGlite } = await import("@electric-sql/pglite");
  const pg = new PGlite(dataDir);
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params);
      return res.rows;
    },
    async exec(sql: string) {
      await pg.exec(sql);
    },
    transaction: (fn) => pg.transaction(async (tx) => {
      const scoped: Db & { exec(sql: string): Promise<void> } = {
        query: async <T>(sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows,
        exec: async (sql: string) => { await tx.exec(sql); },
        close: async () => {},
        transaction: async (nested) => nested(scoped),
      };
      return fn(scoped);
    }),
    close: () => pg.close(),
  };
}

export async function openPostgres(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  // Return dates as plain strings so DATE columns don't shift across timezones.
  pg.types.setTypeParser(1082, (v: string) => v);
  const pool = new pg.Pool({ connectionString, max: 5 });
  return {
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params);
      return res.rows as T[];
    },
    async transaction(fn) {
      const client = await pool.connect();
      const scoped: Db = {
        query: async <T>(sql: string, params: unknown[] = []) => (await client.query(sql, params)).rows as T[],
        close: async () => {},
        transaction: async (nested) => nested(scoped),
      };
      try {
        await client.query("BEGIN");
        const result = await fn(scoped);
        await client.query("COMMIT");
        return result;
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally { client.release(); }
    },
    close: () => pool.end(),
  };
}

/** DATABASE_URL set: Postgres. Otherwise a local PGlite database in .data/ for development. */
export async function openFromEnv(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  if (url) return openPostgres(url);
  const dir = process.env.PGLITE_DIR ?? ".data/pglite";
  // PGlite creates the data directory but not its parents (.data/ on a fresh clone).
  await mkdir(dirname(dir), { recursive: true });
  return openPglite(dir);
}
