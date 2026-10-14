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
      <p class="lede">Get texts from the front desk during your stay. Reply any time if you need something.</p>
      ${error ? html`<p class="err" role="alert">${error}</p>` : ""}
      <form method="post" class="card">
        <label>Last name <input name="last_name" autocomplete="family-name" required value="${values.last_name ?? ""}" /></label>
        <label>Room number <input name="room" inputmode="numeric" required value="${values.room ?? ""}" /></label>
        <label>Mobile number <input name="phone" type="tel" autocomplete="tel" required value="${values.phone ?? ""}" /></label>
        <label><input type="checkbox" name="agree" value="1" />${renderTemplate(CONSENT_TEXT, { property_name: p.name })}</label>
        <button type="submit" class="wide" data-busy-text="Signing you up…">Sign me up</button>
      </form>
    </div>`,
    { nav: false },
  );
}

export function checkinDone(p: Property, linked: boolean) {
  return layout(
    p.name,
    linked
      ? html`<div class="narrow done">
          <p class="done-title">You’re all set.</p>
          <p class="lede">We just sent you a text. Reply to it any time during your stay.</p>
        </div>`
      : html`<div class="narrow done">
          <p class="done-title">Almost there.</p>
          <p class="lede">Show this screen at the front desk. Once they confirm it’s you, we’ll send your first text.</p>
          <p class="muted small">If you need anything right now, call the front desk.</p>
        </div>`,
    { nav: false },
  );
}

export async function qrSign(p: Property, url: string) {
  // One sign per printed page; the Print button prints only this one.
  const svg = await QRCode.toString(url, { type: "svg", margin: 1, width: 280 });
  return html`<div class="card sign" id="sign-${p.id}">
    <button type="button" class="secondary sm noprint sign-print" onclick="document.body.dataset.print='1';this.closest('.sign').classList.add('print-me');window.print();">Print this sign</button>
    <p class="muted small">${p.name}</p>
    <h3>Need anything during your stay? Text us.</h3>
    <p class="muted">Scan to get texts from the front desk.</p>
    <div class="qr">${raw(svg)}</div>
    <p class="muted small">${url}</p>
  </div>`;
}
