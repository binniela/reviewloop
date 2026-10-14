import { html, raw } from "hono/html";
import QRCode from "qrcode";
import { CONSENT_TEXT } from "../consent.js";
import { renderTemplate } from "../guest.js";
import type { Property } from "../properties.js";
import { layout } from "./layout.js";

/** Guest-facing check-in opt-in page, and the printable QR sign for the front desk. */

export function checkinForm(p: Property, error?: string, values: Record<string, string> = {}) {
  return layout(
    p.name,
    html`<div class="narrow">
      <p>Get texts from the front desk during your stay. Reply any time if you need something.</p>
      ${error ? html`<p class="err">${error}</p>` : ""}
      <form method="post" class="card">
        <label>Last name <input name="last_name" autocomplete="family-name" required value="${values.last_name ?? ""}" /></label>
        <label>Room number <input name="room" inputmode="numeric" required value="${values.room ?? ""}" /></label>
        <label>Mobile number <input name="phone" type="tel" autocomplete="tel" required value="${values.phone ?? ""}" /></label>
        <label><input type="checkbox" name="agree" value="1" />${renderTemplate(CONSENT_TEXT, { property_name: p.name })}</label>
        <button type="submit">Sign me up</button>
      </form>
    </div>`,
    { nav: false },
  );
}

export function checkinDone(p: Property, linked: boolean) {
  return layout(
    p.name,
    html`<div class="narrow card">
      <p><strong>You're all set.</strong></p>
      <p>
        ${linked
          ? "We just sent you a text. Reply to it any time during your stay."
          : "We'll connect your number to your room shortly. If you need anything right now, please call the front desk."}
      </p>
    </div>`,
    { nav: false },
  );
}

export async function qrSign(p: Property, url: string) {
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 280 });
  return html`<div class="card" style="text-align:center">
    <h2>${p.name}</h2>
    <p><strong>Need anything during your stay? Text us.</strong><br />Scan to get texts from the front desk.</p>
    <div class="qr">${raw(svg)}</div>
    <p class="muted">${url}</p>
  </div>`;
}
