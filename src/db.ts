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
const migrationFiles = async () => (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

/** Production requests check schema state; only the explicit migration command changes it. */
export async function assertMigrated(db: Db): Promise<void> {
  const files = await migrationFiles();
  const [table] = await db.query<{ exists: string | null }>("select to_regclass('public.schema_migrations')::text as exists");
  const applied = table?.exists
    ? new Set((await db.query<{ name: string }>("select name from schema_migrations")).map((r) => r.name))
    : new Set<string>();
  const pending = files.filter((f) => !applied.has(f));
  if (pending.length) throw new Error(`Database migrations pending: ${pending.join(", ")}. Run npm run migrate before serving traffic.`);
}

/** Existing-table indexes are built without the write lock held by plain CREATE INDEX. */
export function onlineIndexSql(sql: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter(Boolean).map((s) => {
    if (!/^create\s+index\s+if\s+not\s+exists\b/i.test(s)) throw new Error("Online index migration must contain only CREATE INDEX IF NOT EXISTS statements");
    return s.replace(/^create\s+index\s+/i, "CREATE INDEX CONCURRENTLY ");
  });
}

async function buildOnlineIndex(client: import("pg").PoolClient, statement: string): Promise<void> {
  const name = statement.match(/^CREATE INDEX CONCURRENTLY IF NOT EXISTS\s+([a-z_][a-z_0-9]*)\b/i)?.[1];
  if (!name) throw new Error("Cannot identify online index name");
  const invalid = await client.query<{ invalid: boolean }>(`select not i.indisvalid as invalid from pg_index i
    join pg_class c on c.oid = i.indexrelid where c.relname = $1`, [name]);
  // A cancelled concurrent build leaves an invalid index; IF NOT EXISTS would silently skip it.
  if (invalid.rows[0]?.invalid) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${name}`);
  await client.query(statement);
}

async function migratePostgres(db: Db & { pool: import("pg").Pool }, files: string[]): Promise<string[]> {
  const client = await db.pool.connect();
  const ran: string[] = [];
  let locked = false;
  try {
    // A session pooler or direct connection is required. Transaction poolers cannot hold this lock.
    await client.query("select pg_advisory_lock(790287316)");
    locked = true;
    await client.query("create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())");
    const applied = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      if (file === "005_inbox_indexes.sql") {
        for (const statement of onlineIndexSql(sql)) await buildOnlineIndex(client, statement);
        await client.query("insert into schema_migrations (name) values ($1)", [file]);
      } else {
        await client.query("BEGIN");
        try {
          // An ALTER TABLE needing a conflicting lock fails quickly instead of freezing live writes.
          await client.query("SET LOCAL lock_timeout = '5s'");
          if (file === "007_send_failures.sql") {
            const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
            for (const statement of statements.filter((s) => !/^create\s+index\b/i.test(s))) await client.query(statement);
          } else await client.query(sql);
          if (file !== "007_send_failures.sql") await client.query("insert into schema_migrations (name) values ($1)", [file]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        }
        if (file === "007_send_failures.sql") {
          // VALIDATE uses a weaker lock than adding a fully validated CHECK in the ALTER transaction.
          await client.query("alter table outbound_queue validate constraint outbound_queue_status_check");
          const index = sql.split(";").map((s) => s.trim()).find((s) => /^create\s+index\b/i.test(s));
          if (index) for (const statement of onlineIndexSql(index)) await buildOnlineIndex(client, statement);
          await client.query("insert into schema_migrations (name) values ($1)", [file]);
        }
      }
      ran.push(file);
    }
    return ran;
  } finally {
    if (locked) await client.query("select pg_advisory_unlock(790287316)").catch(() => {});
    client.release();
  }
}

export async function migrate(db: Db): Promise<string[]> {
  const files = await migrationFiles();
  if ("pool" in db) return migratePostgres(db as Db & { pool: import("pg").Pool }, files);
  const ran: string[] = [];
  // PGlite keeps local/test migrations and their ledger entries atomic.
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

/**
 * TLS for the pool. node-postgres treats sslmode=require as verify-full, which rejects Supabase's
 * certificate chain, and settings parsed from the URL override any `ssl` passed alongside it.
 * Remove sslmode from the URL and verify remote certificates. A provider-specific CA can be
 * supplied through DATABASE_CA_CERT. Remote plaintext connections are refused.
 */
export function pgPoolConfig(connectionString: string, env: NodeJS.ProcessEnv = process.env) {
  const url = new URL(connectionString);
  const mode = url.searchParams.get("sslmode");
  url.searchParams.delete("sslmode");
  const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (!local && mode === "disable") throw new Error("Remote Postgres connections require verified TLS");
  const ca = env.DATABASE_CA_CERT?.replace(/\\n/g, "\n").trim();
  const ssl = local && (mode === "disable" || !mode) ? false : ca ? { ca, rejectUnauthorized: true } : { rejectUnauthorized: true };
  return { connectionString: url.toString(), ssl };
}

export async function openPostgres(connectionString: string): Promise<Db & { pool: import("pg").Pool }> {
  const { default: pg } = await import("pg");
  // Return dates as plain strings so DATE columns don't shift across timezones.
  pg.types.setTypeParser(1082, (v: string) => v);
  const pool = new pg.Pool({ ...pgPoolConfig(connectionString), max: 5 });
  // The pooler closes idle connections. Without a listener that 'error' event crashes the process;
  // the pool discards the dead client and the next query opens a fresh one.
  pool.on("error", (err) => console.error("postgres idle client error", err.message));
  return {
    pool,
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
      let result: Awaited<ReturnType<typeof fn>>;
      try {
        await client.query("BEGIN");
        result = await fn(scoped);
        await client.query("COMMIT");
      } catch (error) {
        // A dropped connection can't roll back; destroy it rather than return it to the pool.
        const broken = await client.query("ROLLBACK").then(() => false, () => true);
        client.release(broken);
        throw error;
      }
      client.release();
      return result;
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
