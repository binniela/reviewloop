import { parse } from "csv-parse/sync";
import { DateTime } from "luxon";
import { z } from "zod";

/**
 * Parses reports exported from ASI (arrivals, in-house, departures, or a full reservation list)
 * into normalized reservation snapshots.
 *
 * ASI's export headers aren't publicly documented, so every column is configurable per
 * property (properties.report_mapping). DEFAULT_MAPPING is a guess to be replaced once we
 * have a real export from a pilot hotel.
 */

export const STAY_STATUSES = ["reserved", "in_house", "checked_out", "cancelled", "no_show"] as const;
export type StayStatus = (typeof STAY_STATUSES)[number];

export const REPORT_KINDS = ["arrivals", "in_house", "departures", "reservations"] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

const mappingSchema = z.object({
  columns: z.object({
    confirmation: z.string(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    fullName: z.string().optional(), // used when the report has one "Last, First" name column
    email: z.string().optional(),
    phone: z.string().optional(),
    smsOptIn: z.string().optional(),
    room: z.string().optional(),
    channel: z.string().optional(),
    arrival: z.string(),
    departure: z.string(),
    status: z.string().optional(),
    checkedOutAt: z.string().optional(), // actual checkout time, if the report includes it
  }),
  dateFormats: z.array(z.string()).min(1),
  dateTimeFormats: z.array(z.string()).default([]),
  statusMap: z.record(z.string(), z.enum(STAY_STATUSES)).default({}),
  truthy: z.array(z.string()).default(["y", "yes", "true", "1", "x"]),
});
export type ReportMapping = z.infer<typeof mappingSchema>;

export const DEFAULT_MAPPING: ReportMapping = {
  columns: {
    confirmation: "Confirmation",
    fullName: "Guest Name",
    email: "Email",
    phone: "Phone",
    smsOptIn: "SMS Opt In",
    room: "Room",
    channel: "Source",
    arrival: "Arrival",
    departure: "Departure",
    status: "Status",
    checkedOutAt: "Check Out Time",
  },
  dateFormats: ["M/d/yyyy", "MM/dd/yyyy", "yyyy-MM-dd", "M/d/yy"],
  dateTimeFormats: ["M/d/yyyy h:mm a", "M/d/yyyy H:mm", "yyyy-MM-dd HH:mm", "h:mm a"],
  statusMap: {
    reserved: "reserved",
    "due in": "reserved",
    confirmed: "reserved",
    "in house": "in_house",
    "checked in": "in_house",
    "checked out": "checked_out",
    "due out": "in_house",
    cancelled: "cancelled",
    canceled: "cancelled",
    "no show": "no_show",
  },
  truthy: ["y", "yes", "true", "1", "x"],
};

export function parseMapping(raw: unknown): ReportMapping {
  if (raw == null) return DEFAULT_MAPPING;
  return mappingSchema.parse(raw);
}

/** Status implied by the report itself when a row has no usable status column. */
const IMPLIED_STATUS: Record<ReportKind, StayStatus | null> = {
  arrivals: "reserved",
  in_house: "in_house",
  departures: "checked_out",
  reservations: null,
};

export interface ReservationSnapshot {
  confirmation: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null; // E.164
  smsOptIn: boolean;
  room: string | null;
  channel: string | null;
  arrivalDate: string; // yyyy-MM-dd
  departureDate: string;
  status: StayStatus;
  checkedOutAt: string | null; // ISO instant, when the report gives a time
}

export interface RowError {
  row: number; // 1-based data row, header excluded
  message: string;
}

export interface ParsedReport {
  reservations: ReservationSnapshot[];
  errors: RowError[];
}

export function parseAsiReport(
  csv: string,
  opts: { kind: ReportKind; mapping?: ReportMapping; timezone: string },
): ParsedReport {
  const mapping = opts.mapping ?? DEFAULT_MAPPING;
  const rows: Record<string, string>[] = parse(csv, {
    columns: (header: string[]) => header.map((h) => h.trim()),
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });

  const reservations: ReservationSnapshot[] = [];
  const errors: RowError[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, i) => {
    const rowNum = i + 1;
    try {
      const snap = toSnapshot(row, mapping, opts.kind, opts.timezone);
      if (!snap) return; // blank/summary row
      // Reports sometimes list a reservation twice (e.g. room move); keep the last row.
      const prev = seen.get(snap.confirmation);
      if (prev !== undefined) reservations[prev] = snap;
      else {
        seen.set(snap.confirmation, reservations.length);
        reservations.push(snap);
      }
    } catch (err) {
      errors.push({ row: rowNum, message: (err as Error).message });
    }
  });
  return { reservations, errors };
}

function toSnapshot(
  row: Record<string, string>,
  m: ReportMapping,
  kind: ReportKind,
  timezone: string,
): ReservationSnapshot | null {
  const get = (col?: string) => {
    if (!col) return null;
    const v = row[col];
    return v == null || v.trim() === "" ? null : v.trim();
  };

  const confirmation = get(m.columns.confirmation);
  if (!confirmation) {
    // Totals and footer rows have no confirmation number; skip them quietly.
    return null;
  }

  let firstName = get(m.columns.firstName);
  let lastName = get(m.columns.lastName);
  const full = get(m.columns.fullName);
  if (full && !firstName && !lastName) [firstName, lastName] = splitName(full);

  const arrivalDate = parseDate(get(m.columns.arrival), m.dateFormats, "arrival");
  const departureDate = parseDate(get(m.columns.departure), m.dateFormats, "departure");
  if (departureDate < arrivalDate) throw new Error(`departure ${departureDate} is before arrival ${arrivalDate}`);

  const rawStatus = get(m.columns.status);
  let status: StayStatus | null = null;
  if (rawStatus) {
    status = m.statusMap[rawStatus.toLowerCase()] ?? null;
    if (!status && !IMPLIED_STATUS[kind]) throw new Error(`unknown status "${rawStatus}"`);
  }
  status ??= IMPLIED_STATUS[kind];
  if (!status) throw new Error("no status column and report kind does not imply one");

  const rawOut = get(m.columns.checkedOutAt);
  const checkedOutAt =
    status === "checked_out" && rawOut ? parseCheckoutTime(rawOut, departureDate, m, timezone) : null;

  const optIn = get(m.columns.smsOptIn);
  return {
    confirmation,
    firstName,
    lastName,
    email: normalizeEmail(get(m.columns.email)),
    phone: normalizePhone(get(m.columns.phone)),
    smsOptIn: optIn ? m.truthy.includes(optIn.toLowerCase()) : false,
    room: get(m.columns.room),
    channel: get(m.columns.channel),
    arrivalDate,
    departureDate,
    status,
    checkedOutAt,
  };
}

export function splitName(full: string): [string | null, string | null] {
  if (full.includes(",")) {
    const [last, first] = full.split(",", 2).map((s) => s.trim());
    return [titleCase(first || null), titleCase(last || null)];
  }
  const parts = full.split(/\s+/);
  if (parts.length === 1) return [titleCase(parts[0]!), null];
  return [titleCase(parts.slice(0, -1).join(" ")), titleCase(parts.at(-1)!)];
}

function titleCase(s: string | null): string | null {
  if (!s) return null;
  // PMS exports are often ALL CAPS; only fix those so "McDonald" survives.
  if (s !== s.toUpperCase()) return s;
  return s.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (c) => c.toUpperCase());
}

function parseDate(raw: string | null, formats: string[], field: string): string {
  if (!raw) throw new Error(`missing ${field} date`);
  for (const f of formats) {
    const dt = DateTime.fromFormat(raw, f);
    if (dt.isValid) return dt.toISODate()!;
  }
  throw new Error(`unrecognized ${field} date "${raw}"`);
}

function parseCheckoutTime(raw: string, departureDate: string, m: ReportMapping, timezone: string): string | null {
  for (const f of m.dateTimeFormats) {
    let dt = DateTime.fromFormat(raw, f, { zone: timezone });
    if (!dt.isValid) continue;
    // Time-only values ("10:42 AM") belong to the departure date.
    if (!/[yd]/.test(f)) {
      const d = DateTime.fromISO(departureDate, { zone: timezone });
      dt = dt.set({ year: d.year, month: d.month, day: d.day });
    }
    return dt.toUTC().toISO();
  }
  return null; // Unparseable time is not fatal; the property's checkout time is used instead.
}

export function normalizeEmail(raw: string | null): string | null {
  if (!raw) return null;
  const e = raw.trim().toLowerCase();
  // OTA-relayed addresses (guest.booking.com, m.expediapartnercentral.com) are real relays and kept.
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

export function normalizePhone(raw: string | null): string | null {
  if (!raw) return null;
  const hasPlus = raw.trim().startsWith("+");
  const digits = raw.replace(/\D/g, "");
  if (hasPlus && digits.length >= 8 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}
