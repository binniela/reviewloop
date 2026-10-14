import { html, raw } from "hono/html";
import { isGm, type Viewer } from "../viewer.js";

/** The signed-in person in the top bar, and the inactivity sign-out on shared front-desk PCs. */

export const ROLE_LABEL = { desk: "Front desk", gm: "GM" } as const;

export const initials = (name: string) =>
  name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";

export function accountMenu(v: Viewer | undefined) {
  if (!v) return "";
  return html`<details class="menu me">
    <summary class="me-btn" aria-label="${v.name}, ${ROLE_LABEL[v.role]}. Account menu"
      ><span class="me-av" aria-hidden="true">${initials(v.name)}</span><span class="me-name">${v.name}</span></summary
    >
    <div class="menu-pop me-pop">
      <div class="me-head">
        <strong>${v.name}</strong>
        <span>${ROLE_LABEL[v.role]}</span>
        ${v.device ? html`<span>On the shared ${v.device.label} PC</span>` : ""}
      </div>
      ${v.id ? html`<a href="/account">Your password and PIN</a>` : ""}
      ${isGm(v) ? html`<a href="/staff">Staff and desk PCs</a><a href="/audit">Activity log</a>` : ""}
      <form method="post" action="/logout"><button type="submit" class="me-out">${v.device ? "Switch person" : "Sign out"}</button></form>
    </div>
  </details>`;
}

/**
 * Desk PCs return to the name picker after a stretch without anyone touching them. Activity is
 * shared across tabs through localStorage, and the page reloads that Guest issues does on new
 * activity don't count, so a quiet desk still signs out. The server enforces the same limit.
 */
export function deskIdle(v: Viewer | undefined) {
  if (!v?.device) return "";
  return html`<form method="post" action="/logout" class="idle-bar" id="rl-idle" role="alert" hidden>
      <input type="hidden" name="idle" value="1" />
      <span>Still there, ${v.name}? Switching to the name screen in <b id="rl-idle-s">60</b>s.</span>
      <button type="button" id="rl-idle-stay">I’m still here</button>
    </form>
    <script>
      ${raw(`(function () {
  var LIMIT = ${v.idleMinutes * 60_000}, WARN = 60000, KEY = "rl_desk_active";
  var mem = Date.now() - ${Math.round(v.idleFor ?? 0) * 1000}, sent = mem;
  var read = function () { try { return Math.max(mem, Number(localStorage.getItem(KEY)) || 0); } catch (e) { return mem; } };
  var mark = function () { mem = Date.now(); try { localStorage.setItem(KEY, String(mem)); } catch (e) {} };
  var bar = document.getElementById("rl-idle"), secs = document.getElementById("rl-idle-s"), out = false;
  ["mousedown", "keydown", "touchstart", "wheel", "submit"].forEach(function (t) { document.addEventListener(t, mark, true); });
  var moved = 0;
  document.addEventListener("mousemove", function () { if (Date.now() - moved > 5000) { moved = Date.now(); mark(); } }, true);
  document.getElementById("rl-idle-stay").addEventListener("click", function () { mark(); bar.hidden = true; });
  setInterval(function () {
    var last = read(), idle = Date.now() - last;
    if (last > sent + 20000) {
      sent = last;
      fetch("/api/activity", { headers: { "x-reviewloop-activity": "1" }, credentials: "same-origin" }).catch(function () {});
    }
    bar.hidden = idle < LIMIT - WARN;
    secs.textContent = String(Math.max(0, Math.ceil((LIMIT - idle) / 1000)));
    if (idle >= LIMIT && !out) { out = true; bar.requestSubmit ? bar.requestSubmit() : bar.submit(); }
  }, 1000);
})();`)}
    </script>`;
}

export const ACCOUNT_CSS = `
.me { position:relative; }
.me-btn { display:flex; align-items:center; gap:8px; height:32px; padding:0 10px 0 3px; border:1px solid var(--line); border-radius:var(--r-pill); background:var(--surface); cursor:pointer; font:500 var(--fs-md)/1 var(--ui); color:var(--ink); }
.me-btn:hover { background:var(--sunk); }
.me[open] .me-btn { background:var(--sunk); border-color:var(--line-2); }
.me-av, .av { display:inline-grid; place-items:center; flex:none; width:24px; height:24px; border-radius:50%; background:var(--bone); color:var(--ink-2); font:600 10.5px/1 var(--ui); letter-spacing:.02em; }
.me-name { max-width:140px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
/* Solid, not glass: a backdrop blur can't work inside the already-blurred top bar. */
.me .me-pop { min-width:230px; background:var(--surface); -webkit-backdrop-filter:none; backdrop-filter:none; border:1px solid var(--line); box-shadow:var(--shadow-3); }
.me-head { display:grid; gap:2px; padding:8px 10px 10px; margin-bottom:4px; border-bottom:1px solid var(--line); }
.me-head strong { font-weight:600; font-size:var(--fs-md); }
.me-head span { color:var(--muted); font-size:var(--fs-sm); }
.me-pop form { margin:4px 0 0; padding-top:4px; border-top:1px solid var(--line); }
.me .me-out { width:100%; justify-content:flex-start; padding:7px 10px; border:0; border-radius:var(--r-xs); background:none; color:var(--ink-2); font:inherit; font-size:var(--fs-md); box-shadow:none; }
.me .me-out:hover { background:var(--hover); box-shadow:none; transform:none; }
.idle-bar { position:fixed; left:50%; bottom:24px; z-index:60; transform:translateX(-50%); display:flex; align-items:center; gap:14px; width:max-content; max-width:calc(100vw - 32px); margin:0; padding:10px 10px 10px 16px; border-radius:var(--r); background:var(--ink); color:var(--paper); box-shadow:var(--shadow-3); font-size:var(--fs-base); }
.idle-bar[hidden] { display:none; }
.idle-bar b { font-variant-numeric:tabular-nums; }
.idle-bar button { background:var(--paper); color:var(--ink); border-color:var(--paper); }
@media (max-width: 760px) {
  .me-btn { padding:0; width:32px; justify-content:center; border-radius:50%; }
  .me-btn .me-av { width:30px; height:30px; }
  .me-name { display:none; }
  .idle-bar { bottom:76px; flex-wrap:wrap; }
}
`;
