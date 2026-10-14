import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { log } from "./log.js";

/** Minimal database surface. Postgres in production (Supabase), PGlite in tests and local dev. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
  transaction<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "db", "migrations");

// Arbitrary constant: every instance contends for the same advisory lock while migrating.
const MIGRATION_LOCK = 72_640_514;

const migrationFiles = async () => (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

/**
 * Applies pending migrations. Serverless instances run this on cold start, so several can start at
 * once after a deploy: a transaction-scoped advisory lock lets one migrate while the others wait,
 * then find nothing to do. Transaction-scoped (not session) locks are safe behind Supabase's
 * transaction pooler. All pending files commit together or not at all.
 */
export async function migrate(db: Db): Promise<string[]> {
  return db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const applied = new Set(
      (await tx.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name),
    );
    const ran: string[] = [];
    for (const file of await migrationFiles()) {
      if (applied.has(file)) continue;
      await execScript(tx, await readFile(join(MIGRATIONS_DIR, file), "utf8"));
      await tx.query("insert into schema_migrations (name) values ($1)", [file]);
      ran.push(file);
    }
    await lockDownDataApi(tx);
    return ran;
  });
}

/** Migration files not yet applied. Empty when the schema matches this build. */
export async function pendingMigrations(db: Db): Promise<string[]> {
  const [exists] = await db.query<{ ok: boolean }>("select to_regclass('schema_migrations') is not null as ok");
  if (!exists?.ok) return migrationFiles();
  const applied = new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name));
  return (await migrationFiles()).filter((f) => !applied.has(f));
}

/**
 * Supabase publishes the public schema (the app's current schema there) through its REST API to anyone holding the project's anon
 * key. Row level security with no policies closes that door; this app connects as the table owner,
 * which RLS does not restrict. Covers tables added by future migrations too.
 */
async function lockDownDataApi(db: Db) {
  const open = await db.query<{ schema: string; name: string }>(
    `select n.nspname as schema, c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = current_schema() and c.relkind = 'r' and not c.relrowsecurity`,
  );
  const ident = (v: string) => `"${v.replace(/"/g, '""')}"`;
  for (const t of open) await db.query(`alter table ${ident(t.schema)}.${ident(t.name)} enable row level security`);
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
  // Serverless: many small instances share Supabase's pooler, so keep each pool small and let idle
  // connections go before the instance is frozen. DATABASE_CA_CERT (Supabase > Database > SSL)
  // verifies the server certificate instead of trusting whatever answers.
  const ca = process.env.DATABASE_CA_CERT?.replace(/\\n/g, "\n");
  const pool = new pg.Pool({
    // pg lets URL parameters override the ssl option, so sslmode must go when we supply the CA.
    connectionString: ca ? withoutSslMode(connectionString) : connectionString,
    max: Number(process.env.PG_POOL_MAX ?? (process.env.VERCEL ? 3 : 5)),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ...(ca ? { ssl: { ca, rejectUnauthorized: true } } : {}),
  });
  // An idle client losing its connection (pooler restart) must not crash the instance.
  pool.on("error", (err) => log.error("db.pool_error", { error: err }));
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

export function withoutSslMode(connectionString: string) {
  const url = new URL(connectionString);
  for (const key of ["sslmode", "sslrootcert", "sslcert", "sslkey"]) url.searchParams.delete(key);
  return url.toString();
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
