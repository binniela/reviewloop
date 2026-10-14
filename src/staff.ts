import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import type { Db } from "./db.js";
import type { Role, Viewer } from "./viewer.js";

/** Staff accounts, sessions, shared desk PCs and the activity log. */

export interface StaffRow {
  id: string;
  username: string;
  name: string;
  role: Role;
  has_password: boolean;
  has_pin: boolean;
  last_active_at: Date | null;
  created_at: Date;
}

const scrypt = (secret: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(secret.normalize("NFKC"), salt, len, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("base64url")}$${(await scrypt(secret, salt, 32)).toString("base64url")}`;
}

const DUMMY_SALT = randomBytes(16);
/** Constant work whether or not there is a stored hash, so timing doesn't reveal which usernames exist. */
export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, salt, key] = (stored ?? "").split("$");
  if (alg !== "scrypt" || !salt || !key) {
    await scrypt(secret, DUMMY_SALT, 32);
    return false;
  }
  const expected = Buffer.from(key, "base64url");
  const got = await scrypt(secret, Buffer.from(salt, "base64url"), expected.length);
  return got.length === expected.length && timingSafeEqual(got, expected);
}

export const newToken = () => randomBytes(32).toString("base64url");
export const tokenHash = (token: string) => createHash("sha256").update(token).digest("hex");
export const displayName = (username: string) => username.charAt(0).toUpperCase() + username.slice(1);

// ---------- Validation. Messages are written for the GM filling in the Staff page.

export function checkName(name: string): string | null {
  if (!name) return "Enter their name.";
  if (name.length > 40) return "Keep the name under 40 characters.";
  return null;
}
export function checkUsername(username: string): string | null {
  return /^[a-z0-9][a-z0-9._-]{1,31}$/.test(username) ? null : "Usernames are 2 to 32 lowercase letters, numbers, dots or dashes.";
}
export function checkPassword(password: string): string | null {
  return password.length >= 8 ? null : "Passwords need at least 8 characters.";
}
export function checkPin(pin: string): string | null {
  if (!/^\d{4}$/.test(pin)) return "A PIN is exactly 4 digits.";
  const d = [...pin].map(Number);
  const step = d[1]! - d[0]!;
  if ((step === 0 || Math.abs(step) === 1) && d.every((x, i) => i === 0 || x - d[i - 1]! === step)) {
    return "Pick a PIN that's harder to guess than 1111 or 1234.";
  }
  return null;
}

/** "Maria Lopez" -> "maria", or "maria2" if that's taken. */
export async function suggestUsername(db: Db, name: string): Promise<string> {
  let root = (name.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").trim().split(/\s+/)[0] ?? "").replace(/[^a-z0-9._-]/g, "").slice(0, 28);
  if (root.length < 2) root = "staff";
  for (let n = 1; ; n++) {
    const candidate = n === 1 ? root : `${root}${n}`;
    if (!(await usernameTaken(db, candidate))) return candidate;
  }
}

// ---------- Accounts

const STAFF_COLS = `id::text, username, name, role, password_hash is not null as has_password, pin_hash is not null as has_pin, last_active_at, created_at`;

export const listStaff = (db: Db) =>
  db.query<StaffRow>(`select ${STAFF_COLS} from staff where removed_at is null order by role = 'gm' desc, lower(name)`);

export async function getStaff(db: Db, id: string) {
  if (!/^\d+$/.test(id)) return null;
  const [row] = await db.query<StaffRow>(`select ${STAFF_COLS} from staff where id = $1 and removed_at is null`, [id]);
  return row ?? null;
}

export async function findByUsername(db: Db, username: string) {
  const [row] = await db.query<StaffRow & { password_hash: string | null }>(
    `select ${STAFF_COLS}, password_hash from staff where lower(username) = lower($1) and removed_at is null`, [username],
  );
  return row ?? null;
}

export async function pinHash(db: Db, id: string) {
  if (!/^\d+$/.test(id)) return null;
  const [row] = await db.query<{ pin_hash: string | null; name: string; role: Role }>(
    "select pin_hash, name, role from staff where id = $1 and removed_at is null", [id],
  );
  return row ?? null;
}

export async function passwordHash(db: Db, id: string) {
  const [row] = await db.query<{ password_hash: string | null }>("select password_hash from staff where id = $1 and removed_at is null", [id]);
  return row?.password_hash ?? null;
}

export async function activeGmCount(db: Db) {
  const [row] = await db.query<{ n: number }>("select count(*)::int as n from staff where role = 'gm' and removed_at is null");
  return row!.n;
}

export async function nameTaken(db: Db, name: string, exceptId?: string) {
  return (await db.query("select 1 from staff where lower(name) = lower($1) and removed_at is null and id::text is distinct from $2", [name, exceptId ?? null])).length > 0;
}

export async function usernameTaken(db: Db, username: string) {
  return (await db.query("select 1 from staff where lower(username) = lower($1) and removed_at is null", [username])).length > 0;
}

export async function createStaff(db: Db, s: { username: string; name: string; role: Role; password?: string; pin?: string; by: string }, now = new Date()) {
  const [row] = await db.query<{ id: string }>(
    `insert into staff (username, name, role, password_hash, pin_hash, created_at, created_by) values ($1, $2, $3, $4, $5, $6, $7) returning id::text`,
    [s.username, s.name, s.role, s.password ? await hashSecret(s.password) : null, s.pin ? await hashSecret(s.pin) : null, now.toISOString(), s.by],
  );
  return row!.id;
}

/** Changing a password or PIN signs that person out everywhere, so an old session can't outlive a reset. */
export async function setSecrets(db: Db, id: string, secrets: { password?: string; pin?: string }, keepSession?: string) {
  if (secrets.password) await db.query("update staff set password_hash = $2 where id = $1", [id, await hashSecret(secrets.password)]);
  if (secrets.pin) await db.query("update staff set pin_hash = $2 where id = $1", [id, await hashSecret(secrets.pin)]);
  await db.query("delete from staff_sessions where staff_id = $1 and token_hash is distinct from $2", [id, keepSession ? tokenHash(keepSession) : null]);
}

export async function setRole(db: Db, id: string, role: Role) {
  await db.query("update staff set role = $2 where id = $1 and removed_at is null", [id, role]);
}

export async function removeStaff(db: Db, id: string, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx.query("update staff set removed_at = $2 where id = $1 and removed_at is null", [id, now.toISOString()]);
    await tx.query("delete from staff_sessions where staff_id = $1", [id]);
  });
}

/** Desk staff with a PIN, for the "Who's at the desk?" screen. */
export const pinStaff = (db: Db) =>
  db.query<{ id: string; name: string; role: Role }>(
    "select id::text, name, role from staff where removed_at is null and pin_hash is not null order by lower(name)",
  );

// ---------- Sessions

export const SESSION_HOURS = 12;

export async function startSession(db: Db, staffId: string, deviceId: string | null, now: Date): Promise<string> {
  const token = newToken();
  await db.query(
    `insert into staff_sessions (token_hash, staff_id, device_id, created_at, last_seen_at, expires_at) values ($1, $2, $3, $4, $4, $5)`,
    [tokenHash(token), staffId, deviceId, now.toISOString(), new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString()],
  );
  await db.query("update staff set last_active_at = $2 where id = $1", [staffId, now.toISOString()]);
  // Housekeeping: expired rows are useless and cheap to drop here.
  await db.query("delete from staff_sessions where expires_at < $1", [now.toISOString()]);
  return token;
}

/**
 * The signed-in person for a session token. `idle` means a desk PC session nobody touched for longer
 * than the idle limit: it has been ended, and the desk goes back to the name picker.
 */
export async function readSession(db: Db, token: string, now: Date, idleMinutes: number): Promise<{ viewer: Viewer; idle: boolean } | null> {
  const [s] = await db.query<{ staff_id: string; name: string; role: Role; device_id: string | null; label: string | null; device_removed: boolean; last_seen_at: Date; expires_at: Date }>(
    `select s.staff_id::text, st.name, st.role, s.device_id, d.label, d.removed_at is not null as device_removed, s.last_seen_at, s.expires_at
       from staff_sessions s join staff st on st.id = s.staff_id and st.removed_at is null
       left join desk_devices d on d.id = s.device_id
      where s.token_hash = $1`,
    [tokenHash(token)],
  );
  if (!s || new Date(s.expires_at) <= now || s.device_removed) {
    if (s) await endSession(db, token);
    return null;
  }
  const viewer: Viewer = {
    id: s.staff_id,
    name: s.name,
    role: s.role,
    device: s.device_id ? { id: s.device_id, label: s.label ?? "Front desk" } : null,
    idleMinutes,
    idleFor: Math.max(0, (now.getTime() - new Date(s.last_seen_at).getTime()) / 1000),
  };
  // The page warns before the limit and signs out by itself; the server allows a minute's grace for lag.
  if (s.device_id && new Date(s.last_seen_at).getTime() + (idleMinutes + 1) * 60_000 <= now.getTime()) {
    await endSession(db, token);
    return { viewer, idle: true };
  }
  return { viewer, idle: false };
}

/** Record activity. Polling for new issues doesn't count, or a desk PC would never sign out. */
export async function touchSession(db: Db, token: string, staffId: string, now: Date) {
  const rows = await db.query(
    "update staff_sessions set last_seen_at = $2 where token_hash = $1 and last_seen_at < $2::timestamptz - interval '15 seconds' returning 1",
    [tokenHash(token), now.toISOString()],
  );
  if (rows.length) await db.query("update staff set last_active_at = $2 where id = $1", [staffId, now.toISOString()]);
}

export async function endSession(db: Db, token: string) {
  await db.query("delete from staff_sessions where token_hash = $1", [tokenHash(token)]);
}

export async function bindSessionToDevice(db: Db, token: string, deviceId: string) {
  await db.query("update staff_sessions set device_id = $2 where token_hash = $1", [tokenHash(token), deviceId]);
}

// ---------- Shared desk PCs

export async function registerDevice(db: Db, label: string, by: string, now: Date) {
  const token = newToken();
  await db.query("insert into desk_devices (id, label, created_at, created_by) values ($1, $2, $3, $4)", [tokenHash(token), label, now.toISOString(), by]);
  return { token, id: tokenHash(token) };
}

export async function readDevice(db: Db, token: string | undefined | false) {
  if (!token) return null;
  const [d] = await db.query<{ id: string; label: string }>("select id, label from desk_devices where id = $1 and removed_at is null", [tokenHash(token)]);
  return d ?? null;
}

export const listDevices = (db: Db) =>
  db.query<{ id: string; label: string; created_at: Date; created_by: string; last_used: Date | null }>(
    `select d.id, d.label, d.created_at, d.created_by, (select max(s.last_seen_at) from staff_sessions s where s.device_id = d.id) as last_used
       from desk_devices d where d.removed_at is null order by d.created_at`,
  );

export async function removeDevice(db: Db, id: string, now: Date) {
  await db.transaction(async (tx) => {
    await tx.query("update desk_devices set removed_at = $2 where id = $1 and removed_at is null", [id, now.toISOString()]);
    await tx.query("delete from staff_sessions where device_id = $1", [id]);
  });
}

// ---------- Activity log

export type AuditAction =
  | "case.take" | "case.text" | "case.resolve" | "case.log" | "consent.approve"
  | "draft.approve" | "draft.post_failed" | "draft.dismiss" | "draft.restore"
  | "signin.password" | "signin.pin" | "signout.idle"
  | "staff.add" | "staff.remove" | "staff.reset" | "staff.role" | "device.add" | "device.remove";

export async function audit(db: Db, who: Pick<Viewer, "id" | "name" | "device">, action: AuditAction, now: Date, subjectId?: string | null, detail?: string) {
  await db.query(
    "insert into audit_log (at, staff_id, actor, action, subject_id, detail, device) values ($1, $2, $3, $4, $5, $6, $7)",
    [now.toISOString(), who.id, who.name, action, subjectId ?? null, detail ?? null, who.device?.label ?? null],
  );
}

// ---------- Moving over from the single shared login

/**
 * Runs once per database: the account that ADMIN_USER / ADMIN_PASSWORD signed in to becomes the first
 * GM, with the same username and password, and the history recorded under that name is linked to it.
 * Nobody has to set anything up before the first sign-in after upgrading.
 */
export async function bootstrapStaff(db: Db, adminUser: string, adminPassword: string, now = new Date()) {
  await db.transaction(async (tx) => {
    await tx.query("select pg_advisory_xact_lock(790287317)");
    if ((await tx.query("select 1 from sync_state where key = 'staff_bootstrap'")).length) return;
    let [gm] = await tx.query<{ id: string }>("select id::text from staff where lower(username) = lower($1) and removed_at is null", [adminUser]);
    if (!gm) {
      let name = displayName(adminUser);
      if ((await tx.query("select 1 from staff where lower(name) = lower($1) and removed_at is null", [name])).length) name = `${name} (GM)`;
      [gm] = await tx.query<{ id: string }>(
        "insert into staff (username, name, role, password_hash, created_at, created_by) values ($1, $2, 'gm', $3, $4, 'setup') returning id::text",
        [adminUser, name, await hashSecret(adminPassword), now.toISOString()],
      );
    }
    await tx.query("update audit_log set staff_id = $1 where staff_id is null and imported and lower(actor) = lower($2)", [gm!.id, adminUser]);
    await tx.query("insert into sync_state (key, value, updated_at) values ('staff_bootstrap', $1, $2)", [adminUser, now.toISOString()]);
  });
}
