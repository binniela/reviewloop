# Chrome Web Store submission

`npm run extension:zip` → upload `dist/reviewloop-extension.zip` in the
[Developer Dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 developer fee).
Bump `version` in `manifest.json` for every new upload.

## Checked

- Manifest V3, service worker background, no remote code, no `eval`, all scripts packaged.
- Icons at 16, 32, 48 and 128 px. Description is under 132 characters.
- Required permissions are only `storage`, `alarms`, `notifications`. Site access is optional and
  requested at runtime for the single console address the person types (`chrome.permissions.request`
  after a click), never all sites.
- Popup works by keyboard, with labelled fields and visible focus.

## Still needed before submitting

1. **Screenshots**: at least one 1280×800 (or 640×400) PNG/JPEG. Take one of the popup over the
   console with a signed-in demo.
2. **Small promo tile**: 440×280.
3. **Privacy policy URL**: required because the popup shows guest message text. The draft below
   must be reviewed by whoever is responsible for privacy, then hosted (for example at
   `/privacy` on the marketing site).
4. **Support email or site** for the listing.

## Listing text

- **Name:** Reviewloop
- **Summary (132 max):** Open guest issues and review replies at a glance, with a toolbar count and alerts for new issues.
- **Category:** Workflow & Planning
- **Description:**
  > For hotels using Reviewloop. See how many guest issues nobody has taken yet, how many are
  > urgent, and how many review replies are waiting, right from the toolbar. Get a notification
  > when a new guest issue comes in, and open the console in one click.
  >
  > You need a Reviewloop console address from your hotel and to be signed in to it in Chrome.

## Privacy practices tab

- **Single purpose:** Shows counts and alerts from the hotel's own Reviewloop console.
- **Permission justifications:**
  - `storage`: remembers the console address you entered and the last count, so a notification
    only fires for new issues.
  - `alarms`: checks the console for new issues once a minute.
  - `notifications`: tells the desk when a new guest issue arrives.
  - Optional host access: reads `/api/status` from the one console address you enter, using your
    existing sign-in to that console.
- **Data use disclosures:** Handles *personal communications* (the text of the newest guest issue,
  shown in the popup and in notifications) and *website content*. Data is read from your own
  console and shown only on this device; it is not sent to the developer or anyone else, not sold,
  and not used for anything else. Check the three certification boxes on that basis.

## Draft privacy policy (review before publishing)

> The Reviewloop Chrome extension connects only to the Reviewloop console address you enter. It
> reads counts of guest issues and review replies, and the text of the newest guest issue, using
> your existing sign-in to that console, and shows them in the toolbar, popup and notifications on
> your computer. It stores the console address and the last count in Chrome's extension storage.
> The extension does not send any data to the developer or to third parties, does not use
> analytics, and does not sell data. Remove the extension to delete what it stored. Questions:
> [support contact].
