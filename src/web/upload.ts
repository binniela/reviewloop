import { parse } from "csv-parse/sync";
import { html } from "hono/html";
import { parseAsiReport, parseMapping, type ReportKind, type ReportMapping } from "../ingest/asiReport.js";
import type { Property } from "../properties.js";
import { icon, layout, phoneLabel, statBox } from "./layout.js";
import type { Freshness } from "./operations.js";

/**
 * Uploading an ASI report: pick the file, then check how Reviewloop reads it (which column is
 * which, and the first five guests as we understood them) before anything is imported. A
 * mismatched export is caught here instead of silently importing nothing.
 */

// The two daily reports first; In-house is the default.
export const REPORT_ORDER: ReportKind[] = ["in_house", "departures", "arrivals", "reservations"];
export const REPORT_LABEL: Record<ReportKind, { name: string; hint: string }> = {
  arrivals: { name: "Arrivals", hint: "Guests expected to check in" },
  in_house: { name: "In-house", hint: "Who’s staying tonight. Starts welcome and check-in texts" },
  departures: { name: "Departures", hint: "Today’s checkouts. Starts review requests" },
  reservations: { name: "Reservations", hint: "Upcoming bookings" },
};

type Field = keyof ReportMapping["columns"];
/** Every column we can read, in the order people think about a guest. */
const FIELDS: { key: Field; label: string; required?: boolean; words: string[] }[] = [
  { key: "confirmation", label: "Confirmation number", required: true, words: ["confirmation", "conf", "reservation", "res #", "booking"] },
  { key: "fullName", label: "Guest name (one column)", words: ["guest name", "name", "guest"] },
  { key: "firstName", label: "First name", words: ["first name", "first"] },
  { key: "lastName", label: "Last name", words: ["last name", "last", "surname"] },
  { key: "room", label: "Room", words: ["room", "room #", "room number", "rm", "rm #"] },
  { key: "phone", label: "Mobile phone", words: ["phone", "mobile", "cell"] },
  { key: "smsOptIn", label: "OK to text", words: ["sms opt in", "sms", "text ok", "opt in"] },
  { key: "email", label: "Email", words: ["email", "e-mail"] },
  { key: "arrival", label: "Arrival date", required: true, words: ["arrival", "arrive", "check in", "checkin"] },
  { key: "departure", label: "Departure date", required: true, words: ["departure", "depart", "check out date"] },
  { key: "status", label: "Status", words: ["status"] },
  { key: "checkedOutAt", label: "Actual checkout time", words: ["check out time", "checkout time", "checked out"] },
  { key: "channel", label: "Booking source", words: ["source", "channel"] },
];

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();

/** The header row and the first few data rows, exactly as they are in the file. */
export function peek(csv: string, n = 5): { headers: string[]; rows: string[][]; total: number } {
  const all: string[][] = parse(csv, { bom: true, skip_empty_lines: true, relax_column_count: true, trim: true });
  const [headers = [], ...rows] = all;
  return { headers, rows: rows.slice(0, n), total: rows.length };
}

/** The hotel's saved mapping where its columns are in this file; otherwise the closest header by name. */
export function guessMapping(headers: string[], current: ReportMapping): ReportMapping {
  const used = new Set<string>();
  const columns: Record<string, string> = {};
  const has = (h: string | undefined) => !!h && headers.includes(h);
  for (const f of FIELDS) {
    const saved = current.columns[f.key];
    if (has(saved) && !used.has(saved!)) {
      columns[f.key] = saved!;
      used.add(saved!);
    }
  }
  for (const f of FIELDS) {
    if (columns[f.key]) continue;
    const hit = f.words.map((w) => headers.find((h) => !used.has(h) && norm(h) === w)).find(Boolean)
      ?? f.words.map((w) => headers.find((h) => !used.has(h) && ` ${norm(h)} `.includes(` ${w} `))).find(Boolean);
    if (hit) {
      columns[f.key] = hit;
      used.add(hit);
    }
  }
  // One name column or first + last, never both.
  if (columns.firstName && columns.lastName) delete columns.fullName;
  else if (columns.fullName) {
    delete columns.firstName;
    delete columns.lastName;
  }
  return { ...current, columns: columns as ReportMapping["columns"] };
}

/** The mapping chosen on the check screen (col_<field> selects), on top of the hotel's saved settings. */
export function mappingFromForm(form: Record<string, unknown>, current: ReportMapping): ReportMapping | null {
  if (!Object.keys(form).some((k) => k.startsWith("col_"))) return null;
  const columns: Record<string, string> = {};
  for (const f of FIELDS) {
    const v = String(form[`col_${f.key}`] ?? "");
    if (v) columns[f.key] = v;
  }
  return { ...current, columns: columns as ReportMapping["columns"] };
}

const missing = (m: ReportMapping) => {
  const out = FIELDS.filter((f) => f.required && !m.columns[f.key]).map((f) => f.label);
  if (!m.columns.fullName && !m.columns.lastName) out.push("Guest name");
  return out;
};

export function uploadPage(props: Property[], fresh: Freshness[], error?: string) {
  return layout(
    "Upload ASI report",
    html`
      <div class="fresh-list">
        ${fresh.map(
          (f) => html`<div class="fresh-row">
            <strong>${f.name}</strong>
            ${f.reports.map(
              (r) => html`<span class="fresh-item">${r.kind === "in_house" ? "In-house" : "Departures"}
                ${r.at
                  ? r.today
                    ? html`<span class="tag good">Today</span>`
                    : html`<span class="tag err">Not today</span>`
                  : html`<span class="tag">Never</span>`}</span>`,
            )}
          </div>`,
        )}
      </div>
      <form method="post" action="/upload/check" enctype="multipart/form-data" class="card form-card">
        ${error ? html`<p class="err" role="alert">${error}</p>` : ""}
        <label>Hotel <select name="property" required>
          ${props.length > 1 ? html`<option value="" selected disabled>Choose a hotel</option>` : ""}
          ${props.map((p) => html`<option value="${p.id}">${p.name}</option>`)}
        </select></label>
        <fieldset class="kinds">
          <legend>Which report is it?</legend>
          ${REPORT_ORDER.map(
            (k, i) => html`<label class="kind"><input type="radio" name="kind" value="${k}" ${i === 0 ? "checked" : ""} required />
              <span><strong>${REPORT_LABEL[k].name}</strong><small>${REPORT_LABEL[k].hint}</small></span></label>`,
          )}
        </fieldset>
        <label class="drop">
          <input type="file" name="file" accept=".csv,text/csv" required onchange="this.closest('.drop').dataset.file = this.files[0] ? this.files[0].name : ''" />
          <span class="drop-cta">${icon("upload")} Choose the CSV file</span>
          <span class="drop-name muted small">Exported from ASI. You’ll check the first few guests before anything is imported.</span>
        </label>
        <button type="submit" class="wide" data-busy-text="Reading the file…">Check the file</button>
      </form>
    `,
    { active: "/upload", lede: "Upload today’s in-house and departures reports each morning. Welcome texts and review requests are timed from them." },
  );
}

/** The check step: which column is which, and the first five guests as we read them. */
export function checkPage(p: Property, kind: ReportKind, csv: string, mapping: ReportMapping | null, fileName: string) {
  const { headers, rows, total } = peek(csv);
  const m = mapping ?? guessMapping(headers, parseMapping(p.report_mapping));
  const gaps = missing(m);
  const parsed = gaps.length ? null : parseAsiReport(csv, { kind, timezone: p.timezone, mapping: m });
  const firstErrors = parsed?.errors.filter((e) => e.row <= 5) ?? [];
  const good = parsed?.reservations.length ?? 0;
  const ok = !!parsed && good > 0;

  const verdict = !headers.length
    ? html`<p class="banner warn" role="alert">${icon("alert")}<strong>This file is empty.</strong> <span>Export the report from ASI as CSV and choose it again.</span></p>`
    : gaps.length
      ? html`<p class="banner warn" role="alert">${icon("alert")}<strong>Choose a column for ${gaps.join(", ")}.</strong>
          <span>If none of the columns fit, this may not be the ${REPORT_LABEL[kind].name} report.</span></p>`
      : !good
        ? html`<p class="banner warn" role="alert">${icon("alert")}<strong>We couldn’t read any guests with these columns.</strong>
            <span>Check each column below, or that this is the ${REPORT_LABEL[kind].name} report.</span></p>`
        : html`<p class="banner ok" role="status">${icon("check")}<strong>${good} guest${good === 1 ? "" : "s"} found in ${total} row${total === 1 ? "" : "s"}.</strong>
            ${parsed!.errors.length ? html`<span>${parsed!.errors.length} row${parsed!.errors.length === 1 ? "" : "s"} can’t be read and will be skipped.</span>` : html`<span>Check the first five below, then import.</span>`}</p>`;

  return layout(
    "Check the report",
    html`
      <form method="post" action="/upload" class="report-check">
        <input type="hidden" name="property" value="${p.id}" />
        <input type="hidden" name="kind" value="${kind}" />
        <input type="hidden" name="file_name" value="${fileName}" />
        <textarea name="csv" hidden>${csv}</textarea>
        <p class="muted small">${fileName || "Your file"} · ${REPORT_LABEL[kind].name} · ${p.name}</p>
        ${verdict}

        <h2>The first five guests, as we read them</h2>
        ${parsed && (parsed.reservations.length || firstErrors.length)
          ? html`<div class="table-wrap"><table>
              <tr><th>Confirmation</th><th>Guest</th><th>Room</th><th>Mobile</th><th>Arrives</th><th>Leaves</th><th>Status</th></tr>
              ${parsed.reservations.slice(0, 5).map(
                (r) => html`<tr>
                  <td>${r.confirmation}</td><td>${[r.firstName, r.lastName].filter(Boolean).join(" ") || html`<span class="err">No name</span>`}</td>
                  <td>${r.room ?? ""}</td><td>${r.phone ? phoneLabel(r.phone) : html`<span class="muted">None</span>`}${r.smsOptIn ? " · OK to text" : ""}</td>
                  <td>${r.arrivalDate}</td><td>${r.departureDate}</td><td>${r.status.replace("_", " ")}</td>
                </tr>`,
              )}
              ${firstErrors.map((e) => html`<tr><td colspan="7" class="err">Row ${e.row}: ${e.message}</td></tr>`)}
            </table></div>`
          : html`<p class="ok-line">Nothing to show yet. Pick the columns below.</p>`}

        <h2>Which column is which</h2>
        <div class="map-grid">
          ${FIELDS.map(
            (f) => html`<label>${f.label}${f.required ? html` <span class="muted">(needed)</span>` : ""}
              <select name="col_${f.key}">
                <option value="">Not in this report</option>
                ${headers.map((h) => html`<option value="${h}" ${m.columns[f.key] === h ? "selected" : ""}>${h}</option>`)}
              </select></label>`,
          )}
        </div>
        <p class="muted small">Use either one guest name column, or first and last name. We’ll remember these columns for ${p.name}.</p>

        <details class="table-details">
          <summary>Show the file’s first rows as they are</summary>
          <div class="table-wrap"><table>
            <tr>${headers.map((h) => html`<th>${h}</th>`)}</tr>
            ${rows.map((r) => html`<tr>${headers.map((_, i) => html`<td>${r[i] ?? ""}</td>`)}</tr>`)}
          </table></div>
        </details>

        <div class="actions">
          <button type="submit" ${ok ? "" : "disabled"} data-busy-text="Importing…">Import ${good || ""} guest${good === 1 ? "" : "s"}</button>
          <button type="submit" class="secondary" formaction="/upload/check" data-busy-text="Checking…">Check again with these columns</button>
          <a class="btn secondary" href="/upload">Choose another file</a>
        </div>
      </form>
    `,
    { active: "/upload" },
  );
}

export function importResultPage(
  r: { created: number; updated: number; unchanged: number; rows: number; rowErrors: { row: number; message: string }[]; consentsLinked: number },
  kind: ReportKind,
) {
  return layout(
    r.rows === 0 && !r.rowErrors.length ? "Nothing imported" : "Report imported",
    html`
      <div class="stats">
        ${statBox("New stays", String(r.created))} ${statBox("Updated", String(r.updated))}
        ${statBox("Unchanged", String(r.unchanged))} ${statBox("Rows with problems", String(r.rowErrors.length))}
      </div>
      ${r.rows === 0 && !r.rowErrors.length
        ? html`<p class="banner warn" role="alert">${icon("alert")}<strong>No guests found in this file.</strong>
            <span>If this report should list guests, check it’s the ${REPORT_LABEL[kind].name} report exported from ASI as CSV, then upload it again.</span></p>`
        : ""}
      ${r.consentsLinked ? html`<p>Linked ${r.consentsLinked} check-in text sign-up${r.consentsLinked === 1 ? "" : "s"} to guests.</p>` : ""}
      ${r.rowErrors.length
        ? html`<h2>Rows with problems</h2>
            <div class="table-wrap"><table>
              <tr><th>Row</th><th>Problem</th></tr>
              ${r.rowErrors.map((e) => html`<tr><td>${e.row}</td><td>${e.message}</td></tr>`)}
            </table></div>`
        : ""}
      <div class="actions"><a class="btn" href="/upload">Upload another</a><a class="btn secondary" href="/issues">Guest issues</a></div>
    `,
    { active: "/upload" },
  );
}
