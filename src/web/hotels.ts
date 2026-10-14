import { html } from "hono/html";
import type { Db } from "../db.js";
import { listProperties, type Property } from "../properties.js";
import { propertyInput, saveProperty } from "../propertyInput.js";
import { icon, layout, phoneLabel, type Flash } from "./layout.js";

/**
 * Hotel setup for the GM: everything a hotel needs before texts and replies can flow, in plain
 * words, plus the first-run checklist that the inbox and this page share.
 */

export interface SetupStep {
  title: string;
  text: string;
  done: boolean;
  href: string;
  cta: string;
}

/** What's left before a hotel is fully running. Every hotel must finish a step for it to count. */
export async function setupSteps(db: Db): Promise<SetupStep[]> {
  const hotels = await listProperties(db);
  const imports = await db.query<{ key: string }>("select key from sync_state where key like 'import:%'");
  const signups = await db.query<{ property_id: string }>("select distinct property_id from consents");
  const first = (pred: (p: Property) => boolean) => hotels.find((p) => !pred(p));
  const step = (title: string, text: string, pred: (p: Property) => boolean, href: (p: Property) => string, cta: string): SetupStep => {
    const todo = first(pred);
    return { title, text, done: hotels.length > 0 && !todo, href: todo ? href(todo) : hotels[0] ? href(hotels[0]) : "/hotels/new", cta };
  };
  return [
    { title: "Add your hotel", text: "Name, time zone and checkout time.", done: hotels.length > 0, href: hotels.length ? "/hotels" : "/hotels/new", cta: "Add a hotel" },
    step("Set the texting number and who gets alerts", "The number guests text, and the desk and GM phones that hear about problems.",
      (p) => !!p.sms_from && (p.desk_phones.length > 0 || !!p.gm_phone), (p) => `/hotels/${p.id}#texting`, "Add numbers"),
    step("Connect your Google listing", "So review requests link to the right place and new reviews come in.",
      (p) => !!p.google_place_id, (p) => `/hotels/${p.id}#google`, "Connect Google"),
    step("Upload today’s reports", "In-house and departures from ASI. Welcome texts and review requests run from them.",
      (p) => imports.some((r) => r.key.startsWith(`import:${p.id}:`)), () => "/upload", "Upload a report"),
    step("Put the QR sign at the desk", "Done once the first guest signs up for texts.",
      (p) => signups.some((s) => s.property_id === p.id), () => "/setup", "Print the sign"),
  ];
}

export function checklist(steps: SetupStep[]) {
  return html`<ol class="steps">
    ${steps.map(
      (s) => html`<li class="${s.done ? "done" : ""}">
        <b>${s.title}${s.done ? html`<span class="sr-only"> (done)</span>` : ""}</b>
        <span>${s.text} ${s.done ? "" : html`<a href="${s.href}">${s.cta}</a>`}</span>
      </li>`,
    )}
  </ol>`;
}

const US_ZONES = [
  ["America/New_York", "Eastern"],
  ["America/Chicago", "Central"],
  ["America/Denver", "Mountain"],
  ["America/Phoenix", "Arizona"],
  ["America/Los_Angeles", "Pacific"],
  ["America/Anchorage", "Alaska"],
  ["Pacific/Honolulu", "Hawaii"],
] as const;

const REPLY_MODES = [
  ["approval_all", "I approve every reply", "Nothing is posted until someone here approves it."],
  ["auto_high", "Post 4 and 5 star replies on their own", "Lower ratings and sensitive topics still wait for you."],
  ["auto_all", "Post every reply on its own", "Sensitive topics still wait for you."],
] as const;

export async function hotelsPage(db: Db, flash?: Flash) {
  const hotels = await listProperties(db);
  const steps = await setupSteps(db);
  const left = steps.filter((s) => !s.done).length;
  return layout(
    "Hotel setup",
    html`
      <h2>${left ? `Getting started · ${steps.length - left} of ${steps.length} done` : "Getting started · all done"}</h2>
      ${checklist(steps)}
      <h2>Hotels</h2>
      ${hotels.length
        ? html`<div class="table-wrap"><table>
            <tr><th>Hotel</th><th>Texting number</th><th>Google</th><th>Replies</th><th></th></tr>
            ${hotels.map(
              (h) => html`<tr>
                <td><strong>${h.name}</strong></td>
                <td>${h.sms_from ? phoneLabel(h.sms_from) : html`<span class="tag err">Not set</span>`}</td>
                <td>${h.google_place_id ? html`<span class="tag good">Connected</span>` : html`<span class="tag err">Not set</span>`}</td>
                <td>${REPLY_MODES.find(([m]) => m === h.reply_mode)?.[1] ?? h.reply_mode}</td>
                <td><a href="/hotels/${h.id}">Edit</a></td>
              </tr>`,
            )}
          </table></div>`
        : html`<p class="empty">No hotels yet.</p>`}
    `,
    {
      active: "/hotels",
      flash,
      lede: "Everything Reviewloop needs to text your guests and answer reviews. Only the GM needs this page.",
      actions: html`<a class="btn sm" href="/hotels/new">${icon("plus")}<span>Add a hotel</span></a>`,
    },
  );
}

/** Form values as typed, so a failed save comes back exactly as they left it. */
export type HotelForm = Record<string, string>;

export function hotelForm(p: Partial<Property> | null, opts: { values?: HotelForm; error?: string; flash?: Flash } = {}) {
  const v = (k: string, fallback = "") => opts.values?.[k] ?? fallback;
  const isNew = !p?.id;
  const zones = (Intl as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? [];
  const tz = v("timezone", p?.timezone ?? "America/Los_Angeles");
  const mode = v("reply_mode", p?.reply_mode ?? "approval_all");
  return layout(
    isNew ? "Add a hotel" : p!.name!,
    html`<form method="post" action="${isNew ? "/hotels" : `/hotels/${p!.id}`}" class="card form-card settings" novalidate>
      ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : ""}
      <fieldset>
        <legend>The hotel</legend>
        <label>Hotel name <input name="name" required autocomplete="organization" value="${v("name", p?.name ?? "")}" /></label>
        <div class="two">
          <label>Time zone
            <select name="timezone">
              <optgroup label="United States">
                ${US_ZONES.map(([z, n]) => html`<option value="${z}" ${z === tz ? "selected" : ""}>${n} (${z})</option>`)}
              </optgroup>
              <optgroup label="Everywhere else">
                ${zones.filter((z) => !US_ZONES.some(([u]) => u === z)).map((z) => html`<option value="${z}" ${z === tz ? "selected" : ""}>${z}</option>`)}
              </optgroup>
            </select>
          </label>
          <label>Checkout time <input name="checkout_time" type="time" required value="${v("checkout_time", p?.checkout_time ?? "11:00")}" /></label>
        </div>
      </fieldset>

      <fieldset id="texting">
        <legend>Texting and alerts</legend>
        <label>Texting number <span class="hint">The number guests text. It comes from your Twilio account.</span>
          <input name="sms_from" type="tel" inputmode="tel" placeholder="(626) 555-0100" value="${v("sms_from", p?.sms_from ? phoneLabel(p.sms_from) : "")}" /></label>
        <label>Front desk phones <span class="hint">Texted when a guest reports a problem. Separate several with commas.</span>
          <input name="desk_phones" type="tel" inputmode="tel" value="${v("desk_phones", (p?.desk_phones ?? []).map(phoneLabel).join(", "))}" /></label>
        <label>GM mobile <span class="hint">Texted when nobody at the desk takes a problem within ${p?.escalation_minutes ?? 20} minutes.</span>
          <input name="gm_phone" type="tel" inputmode="tel" value="${v("gm_phone", p?.gm_phone ? phoneLabel(p.gm_phone) : "")}" /></label>
      </fieldset>

      <fieldset id="google">
        <legend>Google listing</legend>
        <label>Google review link or Place ID
          <span class="hint">Search for your hotel in Google’s <a href="https://developers.google.com/maps/documentation/places/web-service/place-id#find-id" target="_blank" rel="noopener">Place ID finder</a>
            and paste the ID (it starts with ChIJ). A link with placeid= in it works too.</span>
          <input name="google_place_id" value="${v("google_place_id", p?.google_place_id ?? "")}" autocomplete="off" /></label>
        <label>Business Profile location <span class="hint">Optional. Looks like accounts/123/locations/456. Needed to read reviews and post replies.</span>
          <input name="google_location" value="${v("google_location", p?.google_location ?? "")}" autocomplete="off" placeholder="accounts/…/locations/…" /></label>
      </fieldset>

      <fieldset>
        <legend>Review replies</legend>
        <div class="kinds">
          ${REPLY_MODES.map(
            ([m, name, hint]) => html`<label class="kind"><input type="radio" name="reply_mode" value="${m}" ${m === mode ? "checked" : ""} />
              <span><strong>${name}</strong><small>${hint}</small></span></label>`,
          )}
        </div>
        <label>Sign replies as <span class="hint">For example “Raj, General Manager”.</span>
          <input name="signoff" value="${v("signoff", p?.signoff ?? "")}" /></label>
      </fieldset>
      <div class="actions">
        <button type="submit" data-busy-text="Saving…">${isNew ? "Add hotel" : "Save changes"}</button>
        <a class="btn secondary" href="/hotels">Cancel</a>
      </div>
    </form>`,
    { active: "/hotels", flash: opts.flash },
  );
}

const slug = (name: string) => name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "hotel";

/** Accepts a raw Place ID, a writereview?placeid= link, or anything with placeid= in it. */
export function placeIdFrom(raw: string): string | null {
  const t = raw.trim();
  if (!t) return null;
  const m = t.match(/[?&]place_?id=([^&#\s]+)/i);
  if (m) return decodeURIComponent(m[1]!);
  if (/^https?:\/\//i.test(t)) throw new Error("That Google link doesn’t include a Place ID. Paste the ID from Google’s Place ID finder instead (it starts with ChIJ).");
  return t;
}

/** Validates a submitted form against the hotel's current settings and saves it. */
export async function saveHotelForm(db: Db, existing: Property | null, form: HotelForm) {
  const list = (s: string) => s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean);
  const blank = (s: string | undefined) => (s && s.trim() ? s.trim() : null);
  let id = existing?.id;
  if (!id) {
    const base = slug(form.name ?? "");
    const taken = new Set((await listProperties(db)).map((h) => h.id));
    id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
  }
  const parsed = propertyInput.safeParse({
    ...(existing ?? {}),
    id,
    name: form.name ?? "",
    timezone: form.timezone || existing?.timezone,
    checkout_time: form.checkout_time,
    sms_from: blank(form.sms_from),
    desk_phones: list(form.desk_phones ?? ""),
    gm_phone: blank(form.gm_phone),
    google_place_id: placeIdFrom(form.google_place_id ?? ""),
    google_location: blank(form.google_location),
    reply_mode: form.reply_mode || "approval_all",
    signoff: (form.signoff ?? "").trim(),
  });
  if (!parsed.success) throw new Error(parsed.error.issues[0]!.message);
  if (!zoneOk(parsed.data.timezone)) throw new Error("Choose a time zone from the list");
  if (parsed.data.google_location && !/^accounts\/[^/]+\/locations\/[^/]+$/.test(parsed.data.google_location))
    throw new Error("The Business Profile location should look like accounts/123/locations/456");
  return saveProperty(db, parsed.data);
}

const zoneOk = (z: string) => {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: z });
    return true;
  } catch {
    return false;
  }
};
