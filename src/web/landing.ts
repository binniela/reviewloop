import { html, raw } from "hono/html";
import type { Downloads } from "../app.js";
import { head, mark } from "./layout.js";

/**
 * Public product page. The product is the hero: one stay told in four beats (catch, fix, ask,
 * reply) inside the real UI, on a soft sky field. Monochrome espresso chrome; color only comes
 * from imagery. Every claim on it is something the code actually does.
 */
export function landingPage({ downloads }: { downloads: Downloads }) {
  const get = (href: string | undefined, label: string) =>
    href ? html`<a class="btn" href="${href}">${label}</a>` : html`<span class="soon">Ask your Reviewloop contact for the installer</span>`;

  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <title>Reviewloop · Guest texting and review replies for independent hotels</title>
        <meta
          name="description"
          content="Reviewloop texts your guests during the stay, catches problems while there is still time to fix them, asks every guest for a review, and drafts every reply."
        />
        ${head(LANDING_CSS)}
      </head>
      <body class="landing">
        <header class="top">
          <a class="brand" href="/welcome">${mark}<span>reviewloop</span></a>
          <nav aria-label="Sections">
            <a href="#product">Product</a><a href="#details">Details</a><a href="#every-guest">Every guest</a><a href="#apps">Apps</a>
          </nav>
          <div class="top-cta">
            <a class="btn secondary" href="/login">Sign in</a>
            <a class="btn" href="/issues">${arrow} Open the console</a>
          </div>
        </header>

        <section class="hero">
          <h1>Every guest heard.<br />Every review answered.</h1>
          <p class="sub">
            Reviewloop texts your guests during the stay, catches problems while there’s still time to fix them, asks every guest for a
            review, and drafts every reply.
          </p>
          <div class="hero-cta">
            <a class="btn big" href="/issues">${arrow} Open the console</a>
            <a class="btn big secondary" href="#apps">Get the app</a>
          </div>
          <p class="proof">Runs on the ASI reports you already export. No PMS integration needed.</p>
        </section>

        <section class="stage" aria-label="One stay, start to finish">
          <div class="field" aria-hidden="true"></div>
          <ol class="beats" aria-hidden="true">
            <li data-step="0"><span>01</span>Catch</li>
            <li data-step="1"><span>02</span>Fix</li>
            <li data-step="2"><span>03</span>Ask</li>
            <li data-step="3"><span>04</span>Reply</li>
          </ol>
          <div class="window">
            <div class="win-rail" aria-hidden="true">
              <span class="rail-mark">${mark}</span>
              <i class="on"></i><i></i><i></i><i></i>
            </div>
            <div class="win-list">
              <div class="win-head">Guest issues <b>3</b></div>
              <div class="row on"><strong>Anita Patel</strong><small>Room 104 · Sunset Inn</small><em>AC really loud</em></div>
              <div class="row"><strong>Marcus Lee</strong><small>Room 210 · Sunset Inn</small><em>No hot water</em><b class="pill warn">Nobody on it</b></div>
              <div class="row"><strong>Ana Gomez</strong><small>Room 118 · Sunset Inn</small><em>Toilet leaking</em><b class="pill warn">Urgent</b></div>
              <div class="row"><strong>Dev Singh</strong><small>Room 4C · Harbor House</small><em>Wi-fi dropping</em><b class="pill ok">Jordan on it</b></div>
            </div>
            <div class="win-thread">
              <div class="win-head">
                <span>Anita Patel <small>· Room 104 · 3 nights</small></span>
                <span class="sat">Stay satisfaction <b data-sat>–</b></span>
              </div>
              <div class="feed" data-feed>
                <div class="b in" data-beat="0">Room is nice but the AC is really loud and kept us up<small>Guest · 10:12 AM</small></div>
                <div class="sys" data-beat="0">Complaint · maintenance · front desk alerted</div>
                <div class="sys ok" data-beat="1">Maria is on it · 4 min</div>
                <div class="b out" data-beat="1">So sorry, Anita. We’re moving you to room 112 now, and breakfast is on us.<small>Maria · 10:16 AM</small></div>
                <div class="sys ok" data-beat="1">Resolved in 18 min · “Moved to 112, comped breakfast”</div>
                <div class="b out" data-beat="2">Is everything better now?<small>Automatic follow-up · 11:00 AM</small></div>
                <div class="b in" data-beat="2">Yes much better, thank you!<small>Guest · 11:03 AM</small></div>
                <div class="sys" data-beat="2">Checked out Wed · review request sent 2 h later</div>
                <div class="review" data-beat="3">
                  <div><span class="stars">★★★★<i>★</i></span> <strong>Anita P.</strong> <small>on Google</small></div>
                  <p>AC was loud the first night but they moved us right away and checked back in. Friendly staff.</p>
                </div>
                <div class="draft" data-beat="3">
                  <small>Reply drafted by Claude in the hotel’s voice</small>
                  <p>Thank you, Anita. Sorry about that first night, and glad room 112 was quieter. We’ve had the AC in 104 serviced. Hope to see you again. Raj, General Manager</p>
                  <span class="posted">Approved by Raj · posted to Google</span>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section class="facts" aria-label="How it behaves">
          <div><b>20 min</b><span>until the GM gets a text if nobody at the desk has taken an issue</span></div>
          <div><b>2 h</b><span>after checkout, every guest is asked for a review</span></div>
          <div><b>48 h</b><span>longest a request waits while an issue is still open</span></div>
          <div><b>8 PM–9 AM</b><span>no texts to guests, in each hotel’s local time</span></div>
        </section>

        <section class="block" id="product">
          ${label("01", "Product", "Guest texting, service recovery, review replies")}
          <div class="block-head">
            <h2>Hear about it during the stay, not in the review.</h2>
            <a class="btn" href="/issues">${arrow} Open the console</a>
          </div>
          <div class="cards3">
            <article class="pcard">
              <p class="kicker">In-stay texts</p>
              <h3>10 AM, the morning after arrival</h3>
              <p class="desc">Guests staying two nights or more get a short check-in text. Anyone can reply any time, and every reply is read.</p>
              <div class="scene sky-a">
                <div class="mini phone">
                  <div class="b out">Morning Anita! How’s everything so far? Reply here if you need anything.</div>
                  <div class="b in">All good, could we get 2 extra towels?</div>
                  <div class="sys">Request · forwarded to the desk</div>
                </div>
              </div>
            </article>
            <article class="pcard">
              <p class="kicker">Service recovery</p>
              <h3>Every complaint has an owner within 20 minutes</h3>
              <p class="desc">Complaints open an issue, the guest gets an acknowledgement, and the desk is alerted. If nobody takes it, the GM’s phone buzzes.</p>
              <div class="scene sky-b">
                <div class="mini list">
                  <div class="li"><span>Toilet leaking · 118</span><b class="pill warn">Urgent</b></div>
                  <div class="li"><span>Smells like cigarettes · 107</span><b class="pill">GM alerted</b></div>
                  <div class="li"><span>No hot water · 210</span><b class="pill warn">Nobody on it</b></div>
                  <div class="li"><span>Wi-fi dropping · 4C</span><b class="pill ok">Jordan on it</b></div>
                </div>
              </div>
            </article>
            <article class="pcard">
              <p class="kicker">Review replies</p>
              <h3>A drafted reply for every review</h3>
              <p class="desc">Claude writes a reply in your hotel’s voice for every new Google review. The GM edits or approves it in one tap. Sensitive topics always wait for a person.</p>
              <div class="scene sky-c">
                <div class="mini rev">
                  <div><span class="stars">★★<i>★★★</i></span> <strong>Lily C.</strong></div>
                  <p>Parking lot lights shine into the window all night.</p>
                  <div class="draftline">Thank you, Lily. You’re right about those lights, and we’ve…</div>
                  <div class="row-btns"><span class="mbtn">Approve and post</span><span class="mbtn alt">Dismiss</span></div>
                </div>
              </div>
            </article>
          </div>
        </section>

        <section class="block" id="details">
          ${label("02", "Details", "The rules it follows on its own")}
          <div class="grid6">
            <article class="fcard tex">
              <canvas class="dither" data-stops="#29251E,#5B3A6B,#C2567A,#F29B6B,#FAD58A" aria-hidden="true"></canvas>
              <div class="fbody">
                <h3>Claude triage, with a keyword backup</h3>
                <p>Every text is labeled by sentiment, category and urgency. If the API is down, keyword rules take over, so no complaint is dropped.</p>
              </div>
            </article>
            <article class="fcard">
              <b class="num">Always</b>
              <h3>Safety words are urgent</h3>
              <p>Smoke, gas, leak, injury, police. Whatever the model says, these go to the top and to the GM.</p>
            </article>
            <article class="fcard">
              <b class="num">STOP</b>
              <h3>Means stop</h3>
              <p>One word blocks every message until the guest texts START. Marketing-style texts only go to guests who opted in.</p>
            </article>
            <article class="fcard">
              <b class="num">1 QR</b>
              <h3>Opt-in at the front desk</h3>
              <p>Print a sign from the console. Guests scan it, enter last name and room, and they’re connected to their stay.</p>
            </article>
            <article class="fcard">
              <b class="num">0</b>
              <h3>Duplicate texts from re-uploads</h3>
              <p>Upload the same ASI report twice and nothing happens twice. A stale report can’t move a guest backwards.</p>
            </article>
            <article class="fcard tex">
              <canvas class="dither" data-stops="#1E3A3A,#2F6E6A,#7DB9A5,#D8E7B0,#FBF1C7" aria-hidden="true"></canvas>
              <div class="fbody">
                <h3>Pilot metrics against your baseline</h3>
                <p>Google review count and rating since launch, plus requests, reply time, issues caught and time to fix, week by week.</p>
              </div>
            </article>
          </div>
        </section>

        <section class="band" id="every-guest">
          <div class="band-inner">
            ${label("03", "Every guest", "Compliant by design", true)}
            <h2>Every guest is asked.<br />Not just the happy ones.</h2>
            <p class="band-sub">
              Asking only satisfied guests for reviews goes against Google’s review policy and FTC guidance. In Reviewloop, how a stay went
              changes <em>when</em> a guest is asked, never <em>whether</em>.
            </p>
            <div class="paths">
              <div class="path">
                <span class="tag-d">Smooth stay</span>
                <div class="track"><i>Checkout</i><s></s><i>+2 h</i><s></s><i class="end">Review request</i></div>
              </div>
              <div class="path">
                <span class="tag-d">Open issue</span>
                <div class="track"><i>Checkout</i><s></s><i>Fixed, or 48 h pass</i><s></s><i class="end">Review request</i></div>
              </div>
            </div>
          </div>
        </section>

        <section class="block" id="apps">
          ${label("04", "Apps", "Front desk, back office, on the go")}
          <div class="block-head">
            <h2>Keep it open at the desk.</h2>
          </div>
          <div class="apps">
            <article class="acard">
              <h3>Mac</h3>
              <p>A native window with a dock badge for issues nobody has taken, and a notification when a new one comes in.</p>
              ${get(downloads.mac, "Download for Mac")}
            </article>
            <article class="acard">
              <h3>Windows</h3>
              <p>For the front desk PC. Taskbar badge, notifications, and it reopens to Guest issues on startup.</p>
              ${get(downloads.windows, "Download for Windows")}
            </article>
            <article class="acard">
              <h3>Chrome</h3>
              <p>Install the console as an app from Chrome, or add the extension for a toolbar count of open issues and replies.</p>
              <div class="row-btns">
                <button type="button" class="btn" id="install" hidden>Install from Chrome</button>
                ${downloads.chrome ? html`<a class="btn secondary" href="${downloads.chrome}">Add the extension</a>` : ""}
                <span class="soon" id="install-hint">In Chrome, open the console and choose Install from the address bar.</span>
              </div>
            </article>
          </div>
        </section>

        <footer class="foot">
          <div class="foot-inner">
            <a class="brand" href="/welcome">${mark}<span>reviewloop</span></a>
            <p>Guest texting, service recovery and review replies for independent hotels on ASI.</p>
            <nav aria-label="Footer"><a href="/issues">Open the console</a><a href="/login">Sign in</a><a href="#apps">Apps</a></nav>
          </div>
        </footer>
        <script>
          ${raw(LANDING_JS)}
        </script>
      </body>
    </html>`;
}

const arrow = raw(
  `<svg class="arr" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M5 11 11 5M6 5h5v5"/></svg>`,
);

const label = (n: string, name: string, desc: string, dark = false) =>
  html`<div class="label ${dark ? "dark" : ""}"><span>[${n}]</span>${name}<i></i><span>/ ${desc}</span></div>`;

const LANDING_JS = `
(function () {
  // Hero story: reveal one beat at a time, hold, then start over.
  var feed = document.querySelector("[data-feed]");
  var steps = document.querySelectorAll(".beats li");
  var sat = document.querySelector("[data-sat]");
  var SAT = ["-0.6", "0.1", "0.7", "0.8"];
  var items = feed ? Array.prototype.slice.call(feed.querySelectorAll("[data-beat]")) : [];
  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  function mark(step) {
    steps.forEach(function (s, i) { s.classList.toggle("on", i === step); s.classList.toggle("done", i < step); });
    if (sat) sat.textContent = step < 0 ? "–" : SAT[step];
  }
  if (reduce) { items.forEach(function (el) { el.classList.add("show"); }); mark(3); }
  else if (items.length) {
    var i = 0;
    (function next() {
      if (i === 0) { items.forEach(function (el) { el.classList.remove("show"); }); mark(-1); }
      if (i < items.length) {
        var el = items[i++];
        el.classList.add("show");
        mark(Number(el.getAttribute("data-beat")));
        setTimeout(next, el.classList.contains("sys") ? 900 : 1500);
      } else { i = 0; setTimeout(next, 5000); }
    })();
  }

  // Dithered gradient textures (ordered Bayer dithering between a few colors).
  var B = [0,32,8,40,2,34,10,42,48,16,56,24,50,18,58,26,12,44,4,36,14,46,6,38,60,28,52,20,62,30,54,22,3,35,11,43,1,33,9,41,51,19,59,27,49,17,57,25,15,47,7,39,13,45,5,37,63,31,55,23,61,29,53,21];
  function hex(h) { return [1, 3, 5].map(function (k) { return parseInt(h.slice(k, k + 2), 16); }); }
  function paint(cv) {
    var stops = cv.getAttribute("data-stops").split(",").map(hex);
    var px = 3, w = Math.max(1, Math.ceil(cv.clientWidth / px)), h = Math.max(1, Math.ceil(cv.clientHeight / px));
    cv.width = w; cv.height = h;
    var ctx = cv.getContext("2d"), img = ctx.createImageData(w, h), n = stops.length - 1;
    for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
      var dx = x / w - 0.15, dy = y / h - 1.05;
      var t = Math.min(1, Math.max(0, 1 - Math.sqrt(dx * dx * 0.9 + dy * dy) * 0.95));
      var v = t * n, k = Math.floor(v), f = v - k;
      var c = stops[Math.min(n, k + (f > (B[(y % 8) * 8 + (x % 8)] + 0.5) / 64 ? 1 : 0))];
      var o = (y * w + x) * 4;
      img.data[o] = c[0]; img.data[o + 1] = c[1]; img.data[o + 2] = c[2]; img.data[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  }
  var canvases = document.querySelectorAll("canvas.dither");
  canvases.forEach(paint);
  var t; window.addEventListener("resize", function () { clearTimeout(t); t = setTimeout(function () { canvases.forEach(paint); }, 150); });

  // Install as an app (Chrome, Edge).
  var btn = document.getElementById("install"), hint = document.getElementById("install-hint"), deferred;
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e; btn.hidden = false; if (hint) hint.hidden = true;
  });
  if (btn) btn.onclick = function () { if (deferred) { deferred.prompt(); deferred = null; btn.hidden = true; } };
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(function () {});
})();
`;

const LANDING_CSS = `
body.landing { background:var(--paper); font-size:16px; overflow-x:hidden; }
.landing .btn { padding:11px 16px; font-size:14px; }
.landing .btn.big { padding:14px 20px; font-size:15px; }
.arr { width:14px; height:14px; transition:transform .16s var(--ease); }
.btn:hover .arr { transform:translate(2px,-2px); }

/* Top bar */
.top { position:sticky; top:0; z-index:10; display:flex; align-items:center; gap:24px; padding:12px clamp(16px, 4vw, 48px); background:color-mix(in srgb, var(--paper) 88%, transparent); backdrop-filter:saturate(1.4) blur(10px); -webkit-backdrop-filter:saturate(1.4) blur(10px); border-bottom:1px solid var(--line); }
.top .brand, .foot .brand { display:flex; align-items:center; gap:9px; text-decoration:none; font:500 20px/1 var(--display); letter-spacing:-.03em; }
.top nav { display:flex; gap:26px; margin-left:24px; }
.top nav a { text-decoration:none; color:var(--muted); font-size:14.5px; transition:color .16s var(--ease); }
.top nav a:hover { color:var(--ink); }
.top-cta { display:flex; gap:8px; margin-left:auto; }

/* Hero */
.hero { text-align:center; padding:clamp(56px, 10vw, 120px) 16px 40px; max-width:1100px; margin:0 auto; }
.hero h1 { font-size:clamp(38px, 8.4vw, 104px); line-height:.98; letter-spacing:-.048em; }
.sub { max-width:640px; margin:26px auto 0; color:var(--muted); font-size:clamp(17px, 2vw, 20px); line-height:1.5; text-wrap:pretty; }
.hero-cta { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:32px; }
.proof { margin:18px 0 0; color:var(--faint); font-size:13.5px; }

/* Stage: the product on a defocused sky field */
.stage { position:relative; margin:24px auto 0; width:min(1240px, calc(100% - 32px)); padding:clamp(56px, 7vw, 88px) clamp(12px, 5vw, 72px) 0; border-radius:24px; overflow:hidden; isolation:isolate; }
.field { position:absolute; inset:0; z-index:-1; background:
    radial-gradient(38% 55% at 12% 30%, #8FD3F2 0%, transparent 70%),
    radial-gradient(40% 50% at 88% 18%, #B9E5F7 0%, transparent 72%),
    radial-gradient(42% 60% at 92% 92%, #9DD08F 0%, transparent 70%),
    radial-gradient(36% 50% at 6% 96%, #F3B562 0%, transparent 70%),
    radial-gradient(30% 40% at 50% 100%, #E9DFA6 0%, transparent 70%),
    linear-gradient(180deg, #A9DDF2, #CFEAF1 60%, #DCEBD5); filter:saturate(1.05); }
.field::after { content:""; position:absolute; inset:0; opacity:.22; mix-blend-mode:overlay; background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='160' height='160'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='.9' numOctaves='2' stitchTiles='stitch'/></filter><rect width='100%' height='100%' filter='url(%23n)'/></svg>"); }
@media (prefers-color-scheme: dark) { .field { filter:saturate(.8) brightness(.55); } }
.beats { list-style:none; display:flex; justify-content:center; gap:6px; margin:0 0 18px; padding:0; }
.beats li { display:flex; align-items:center; gap:7px; padding:6px 12px 6px 8px; border-radius:999px; font:500 12.5px/1 var(--ui); color:rgba(41,37,30,.6); background:rgba(255,255,255,.38); border:1px solid rgba(255,255,255,.5); transition:all .3s var(--ease); }
.beats li span { font-variant-numeric:tabular-nums; font-size:11px; opacity:.7; }
.beats li.done { color:rgba(41,37,30,.85); }
.beats li.on { background:#fff; color:#29251E; box-shadow:0 6px 18px -8px rgba(41,37,30,.4); }

.window { display:grid; grid-template-columns:52px 250px minmax(0,1fr); height:520px; background:#FBFAF7; color:#29251E; border-radius:14px 14px 0 0; border:1px solid rgba(255,255,255,.7); border-bottom:0; box-shadow:0 30px 80px -30px rgba(26,40,52,.55), 0 0 0 1px rgba(41,37,30,.06); overflow:hidden; font:13px/1.45 var(--ui); text-align:left; }
.win-rail { display:flex; flex-direction:column; align-items:center; gap:14px; padding:14px 0; background:#F3F1EC; border-right:1px solid #E8E4DC; }
.rail-mark { display:grid; place-items:center; width:28px; height:28px; border-radius:8px; background:#29251E; color:#F4EFE6; margin-bottom:6px; }
.rail-mark .mark { width:18px; height:18px; }
.win-rail i { width:18px; height:18px; border-radius:5px; border:1.5px solid #B9B4AA; }
.win-rail i.on { border-color:#29251E; background:#fff; }
.win-list { border-right:1px solid #E8E4DC; background:#FBFAF7; overflow:hidden; }
.win-head { display:flex; align-items:center; justify-content:space-between; gap:8px; height:46px; padding:0 16px; border-bottom:1px solid #E8E4DC; font-weight:600; font-size:13px; }
.win-head b { font-weight:600; font-size:11px; padding:1px 7px; border-radius:999px; background:#29251E; color:#FBFAF7; }
.win-head small { font-weight:400; color:#706D67; }
.sat { font-weight:400; color:#706D67; font-size:12px; } .sat b { background:#EDF4EC; color:#3B6B45; font-variant-numeric:tabular-nums; min-width:34px; text-align:center; display:inline-block; }
.row { display:grid; grid-template-columns:1fr auto; gap:1px 8px; padding:12px 16px; border-bottom:1px solid #EFECE6; }
.row strong { font-weight:600; } .row small { grid-column:1; color:#706D67; font-size:11.5px; } .row em { grid-column:1; font-style:normal; color:#4A463F; }
.row .pill { grid-column:2; grid-row:1 / span 2; align-self:center; }
.row.on { background:#fff; box-shadow:inset 2px 0 0 #29251E; }
.pill { font:500 10.5px/1 var(--ui); padding:4px 7px; border-radius:999px; background:#F3F1EC; color:#4A463F; white-space:nowrap; }
.pill.warn { background:#FBEEE9; color:#A8402B; } .pill.ok { background:#EDF4EC; color:#3B6B45; }
.win-thread { display:flex; flex-direction:column; min-width:0; background:#fff; }
.feed { flex:1; display:flex; flex-direction:column; justify-content:flex-end; gap:8px; padding:18px 22px 22px; overflow:hidden; }
.feed > * { display:none; }
.feed > .show { display:block; animation:rise .45s var(--ease) both; }
@keyframes rise { from { opacity:0; transform:translateY(8px); } to { opacity:1; transform:none; } }
.b { max-width:74%; padding:9px 13px; border-radius:16px; font-size:13.5px; line-height:1.45; }
.b small { display:block; margin-top:3px; font-size:10.5px; opacity:.6; }
.b.in { align-self:flex-start; background:#F3F1EC; border-bottom-left-radius:5px; }
.b.out { align-self:flex-end; background:#29251E; color:#FBFAF7; border-bottom-right-radius:5px; }
.sys { align-self:center; font-size:11.5px; color:#706D67; padding:3px 10px; border-radius:999px; border:1px solid #E8E4DC; }
.sys.ok { color:#3B6B45; border-color:#D5E6D3; background:#F4F9F3; }
.review, .draft { align-self:stretch; border:1px solid #E8E4DC; border-radius:12px; padding:12px 14px; }
.review p, .draft p { margin:6px 0 0; } .review small, .draft small { color:#706D67; font-size:11.5px; }
.draft { background:#FBFAF7; } .posted { display:inline-block; margin-top:8px; font:500 11px/1 var(--ui); color:#3B6B45; background:#EDF4EC; padding:4px 8px; border-radius:999px; }
.stars { color:#B7832F; letter-spacing:1px; } .stars i { font-style:normal; color:#DAD5CB; }

/* Facts strip: every line leads with a number */
.facts { display:grid; grid-template-columns:repeat(4, 1fr); width:min(1240px, calc(100% - 32px)); margin:0 auto; border-bottom:1px solid var(--line); }
.facts div { padding:28px 24px 30px; border-left:1px solid var(--line); }
.facts div:first-child { border-left:0; }
.facts b { display:block; font:400 34px/1 var(--display); letter-spacing:-.035em; margin-bottom:10px; font-variant-numeric:tabular-nums; }
.facts span { color:var(--muted); font-size:14px; line-height:1.45; display:block; max-width:24ch; }

/* Sections */
.block { width:min(1240px, calc(100% - 32px)); margin:0 auto; padding:clamp(72px, 10vw, 128px) 0 0; }
.label { display:flex; align-items:center; gap:12px; font:500 11.5px/1 var(--ui); letter-spacing:.1em; text-transform:uppercase; color:var(--muted); margin-bottom:32px; }
.label i { flex:1; height:1px; background:var(--line-2); }
.label span:first-child { color:var(--ink); }
.label.dark { color:rgba(251,250,247,.56); } .label.dark i { background:rgba(251,250,247,.16); } .label.dark span:first-child { color:#FBFAF7; }
.block-head { display:flex; align-items:flex-end; justify-content:space-between; gap:24px; margin-bottom:40px; }
.block h2, .band h2 { display:block; margin:0; font:400 clamp(34px, 5vw, 60px)/1.02 var(--display); letter-spacing:-.04em; text-transform:none; color:inherit; max-width:15ch; text-wrap:balance; }
.block h2::after, .band h2::after { display:none; }

.cards3 { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
.pcard { display:flex; flex-direction:column; padding:28px 28px 0; background:var(--sunk); border:1px solid var(--line); border-radius:18px; overflow:hidden; }
.kicker { margin:0 0 36px; font-size:14px; font-weight:500; color:var(--ink-2); }
.pcard h3 { margin:0 0 12px; font:400 26px/1.15 var(--display); letter-spacing:-.03em; }
.desc { margin:0 0 28px; color:var(--muted); font-size:15px; line-height:1.5; }
.scene { margin:auto -28px 0; height:250px; padding:28px 24px 0; display:flex; align-items:flex-end; justify-content:center; }
.sky-a { background:radial-gradient(70% 90% at 20% 10%, #A5DCF3, transparent), radial-gradient(60% 80% at 90% 100%, #F2C27A, transparent), #CFE8EE; }
.sky-b { background:radial-gradient(70% 90% at 80% 0%, #B6E2F5, transparent), radial-gradient(70% 80% at 0% 100%, #B9D9A0, transparent), #D6ECEE; }
.sky-c { background:radial-gradient(70% 90% at 50% 0%, #C6E6F2, transparent), radial-gradient(60% 70% at 100% 100%, #E7B7C8, transparent), radial-gradient(50% 60% at 0% 100%, #F6D58E, transparent), #DCEAF0; }
@media (prefers-color-scheme: dark) { .scene { filter:brightness(.6) saturate(.85); } .scene .mini { filter:brightness(1.66) saturate(1.18); } }
.mini { width:100%; max-width:330px; background:#fff; color:#29251E; border-radius:12px 12px 0 0; padding:14px; font:12.5px/1.45 var(--ui); box-shadow:0 18px 40px -18px rgba(26,40,52,.5); display:flex; flex-direction:column; gap:7px; min-height:190px; }
.mini .b { font-size:12.5px; max-width:88%; }
.mini .sys { font-size:11px; }
.li { display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 4px; border-bottom:1px solid #EFECE6; }
.li:last-child { border-bottom:0; }
.rev p { margin:2px 0; color:#4A463F; }
.draftline { padding:8px 10px; border-radius:8px; background:#F3F1EC; color:#4A463F; }
.row-btns { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin-top:auto; }
.mbtn { font:500 11.5px/1 var(--ui); padding:8px 11px; border-radius:7px; background:#29251E; color:#FBFAF7; }
.mbtn.alt { background:#fff; color:#29251E; border:1px solid #D9D4CA; }

.grid6 { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
.fcard { position:relative; display:flex; flex-direction:column; min-height:260px; padding:26px; border:1px solid var(--line); border-radius:18px; background:var(--surface); overflow:hidden; }
.fcard h3 { margin:0 0 8px; font:400 21px/1.2 var(--display); letter-spacing:-.025em; }
.fcard p { margin:0; color:var(--muted); font-size:14.5px; line-height:1.5; }
.num { display:block; margin-bottom:auto; padding-bottom:40px; font:400 48px/1 var(--display); letter-spacing:-.045em; }
.fcard.tex { color:#FBFAF7; border-color:transparent; background:#29251E; justify-content:flex-end; }
.fcard.tex canvas { position:absolute; inset:0; width:100%; height:100%; image-rendering:pixelated; }
.fcard.tex .fbody { position:relative; padding:18px; margin:-8px; border-radius:12px; background:rgba(41,37,30,.72); backdrop-filter:blur(2px); }
.fcard.tex p { color:rgba(251,250,247,.72); }

/* Dark band */
.band { margin-top:clamp(72px, 10vw, 128px); background:#29251E; color:#FBFAF7; }
@media (prefers-color-scheme: dark) { .band { background:#0E0C0A; border-block:1px solid var(--line); } }
.band-inner { width:min(1240px, calc(100% - 32px)); margin:0 auto; padding:clamp(72px, 10vw, 120px) 0; }
.band h2 { max-width:18ch; }
.band-sub { max-width:620px; margin:28px 0 48px; color:rgba(251,250,247,.72); font-size:18px; line-height:1.55; }
.band-sub em { font-style:normal; color:#FBFAF7; border-bottom:1px solid rgba(251,250,247,.4); }
.paths { display:grid; gap:12px; max-width:880px; }
.path { display:grid; grid-template-columns:130px 1fr; align-items:center; gap:20px; padding:18px 20px; border:1px solid rgba(251,250,247,.12); border-radius:14px; background:rgba(251,250,247,.03); }
.tag-d { font-size:13px; color:rgba(251,250,247,.64); }
.track { display:flex; align-items:center; gap:10px; min-width:0; }
.track i { font-style:normal; font-size:13.5px; white-space:nowrap; color:rgba(251,250,247,.8); }
.track i.end { padding:5px 10px; border-radius:999px; background:#FBFAF7; color:#29251E; font-weight:500; }
.track s { flex:1; min-width:16px; height:1px; background:repeating-linear-gradient(90deg, rgba(251,250,247,.35) 0 4px, transparent 4px 8px); }

/* Apps */
.apps { display:grid; grid-template-columns:repeat(3, 1fr); gap:16px; }
.acard { display:flex; flex-direction:column; gap:10px; padding:28px; border:1px solid var(--line); border-radius:18px; background:var(--surface); }
.acard h3 { margin:0; font:400 28px/1 var(--display); letter-spacing:-.035em; }
.acard p { margin:0 0 14px; color:var(--muted); font-size:15px; line-height:1.5; flex:1; }
.acard .btn { align-self:flex-start; }
.soon { color:var(--faint); font-size:13px; }

/* Footer */
.foot { margin-top:clamp(72px, 10vw, 128px); background:#29251E; color:#FBFAF7; }
@media (prefers-color-scheme: dark) { .foot { background:#0E0C0A; border-top:1px solid var(--line); } }
.foot-inner { width:min(1240px, calc(100% - 32px)); margin:0 auto; padding:48px 0 56px; display:flex; flex-wrap:wrap; align-items:center; gap:16px 32px; }
.foot p { margin:0; color:rgba(251,250,247,.56); font-size:14px; flex:1; min-width:240px; }
.foot nav { display:flex; gap:22px; }
.foot nav a { color:rgba(251,250,247,.8); text-decoration:none; font-size:14px; } .foot nav a:hover { color:#fff; }

@media (max-width: 1020px) {
  .window { grid-template-columns:44px minmax(0,1fr); }
  .win-list { display:none; }
  .cards3, .grid6, .apps { grid-template-columns:1fr 1fr; }
  .facts { grid-template-columns:1fr 1fr; }
  .facts div:nth-child(3) { border-left:0; }
  .facts div:nth-child(n+3) { border-top:1px solid var(--line); }
}
@media (max-width: 720px) {
  .top nav, .top-cta .secondary { display:none; }
  .top-cta .btn { padding:9px 12px; font-size:13px; }
  .window { grid-template-columns:minmax(0,1fr); height:480px; }
  .win-rail { display:none; }
  .win-head .sat { display:none; }
  .feed { padding:14px; }
  .b { max-width:88%; }
  .beats li { padding:5px 9px 5px 7px; font-size:12px; }
  .cards3, .grid6, .apps { grid-template-columns:1fr; }
  .block-head { flex-direction:column; align-items:flex-start; }
  .path { grid-template-columns:1fr; gap:10px; }
  .track { flex-wrap:wrap; } .track s { display:none; } .track i:not(.end)::after { content:"→"; margin-left:10px; opacity:.5; }
  .facts div { padding:22px 16px; }
  .facts b { font-size:28px; }
}
@media (prefers-reduced-motion: reduce) { .feed > * { display:block; } }
`;
