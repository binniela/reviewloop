/**
 * One JSON object per line, so Vercel's log search and any log drain can filter by `msg` and fields.
 * Never pass guest phone numbers, names, or message bodies: logs leave the database's protection.
 */
type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function write(level: Level, msg: string, fields: Fields = {}) {
  const entry: Fields = { level, msg, ...fields };
  const err = fields.error;
  if (err instanceof Error) entry.error = { message: err.message, name: err.name, stack: err.stack };
  const line = JSON.stringify(entry);
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Fields) => write("info", msg, fields),
  warn: (msg: string, fields?: Fields) => write("warn", msg, fields),
  error: (msg: string, fields?: Fields) => write("error", msg, fields),
};
