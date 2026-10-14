import { html } from "hono/html";
import { head, isDemo, mark } from "./layout.js";

export function loginPage(opts: { next: string; user?: string; error?: string }) {
  return html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Sign in · Reviewloop</title>
        ${head(LOGIN_CSS)}
      </head>
      <body class="login">
        <div class="sky" aria-hidden="true"></div>
        <main class="login-card">
          <a class="brand" href="/welcome">${mark}<span>reviewloop</span></a>
          <h1>Welcome back.</h1>
          <p class="muted">Sign in to the front desk console.</p>
          ${opts.error ? html`<p class="err" role="alert">${opts.error}</p>` : ""}
          ${isDemo() ? html`<p class="hint">Demo GM: username <b>demo</b>, password <b>demo</b>. Front desk: <b>maria</b> / <b>desk-demo</b></p>` : ""}
          <form method="post" action="/login">
            <input type="hidden" name="next" value="${opts.next}" />
            <label>Username <input name="user" autocomplete="username" required value="${opts.user ?? ""}" autofocus /></label>
            <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
            <button type="submit" class="wide">Sign in</button>
          </form>
        </main>
      </body>
    </html>`;
}

export const LOGIN_CSS = `
body.login { min-height:100vh; display:grid; place-items:center; padding:24px 16px; position:relative; overflow:hidden; }
.sky { position:fixed; inset:-10%; z-index:0; filter:blur(48px) saturate(1.05); opacity:.9;
  background:
    radial-gradient(40% 50% at 20% 25%, #9ED8F0 0%, transparent 70%),
    radial-gradient(45% 45% at 80% 20%, #BFE6F5 0%, transparent 70%),
    radial-gradient(50% 50% at 75% 85%, #A9D4A0 0%, transparent 70%),
    radial-gradient(40% 40% at 15% 90%, #E9C98F 0%, transparent 70%), #DCEFF5; }
.login-card { position:relative; z-index:1; width:100%; max-width:380px; padding:32px 28px 28px; border-radius:20px; background:rgba(255,255,255,.62); -webkit-backdrop-filter:blur(28px) saturate(180%); backdrop-filter:blur(28px) saturate(180%); border:1px solid rgba(255,255,255,.75); box-shadow:inset 0 1px 0 #fff, inset 0 -1px 0 rgba(255,255,255,.3), 0 30px 70px -28px rgba(26,40,52,.45); }
.login-card input { background:rgba(255,255,255,.75); }
.hint { background:rgba(255,255,255,.55) !important; }
.login-card .brand { display:inline-flex; align-items:center; gap:8px; text-decoration:none; font:500 18px/1 var(--display); letter-spacing:-.03em; margin-bottom:28px; }
.login-card h1 { font-size:34px; margin-bottom:6px; }
.login-card .muted { margin:0 0 22px; }
.login-card .err { margin:0 0 16px; padding:9px 12px; border-radius:8px; background:var(--warn-bg); font-size:13px; }
.hint { margin:0 0 16px; padding:9px 12px; border-radius:8px; background:var(--sunk); font-size:13px; color:var(--ink-2); }
`;
