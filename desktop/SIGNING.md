# Signed installers

`npm run dist` builds signed, notarized installers, or stops and says exactly which variable is
missing. `npm run signing:check` runs only that check. `UNSIGNED=1 npm run dist` makes a test build;
never send one of those to a hotel (macOS blocks it and Windows shows a SmartScreen warning).

```bash
cd desktop
npm install
REVIEWLOOP_URL=https://reviewloop.yourhotel.com npm run dist:mac   # on a Mac
REVIEWLOOP_URL=https://reviewloop.yourhotel.com npm run dist:win   # on Windows (or a Mac with a .pfx)
```

Output goes to `desktop/dist/`: one universal `.dmg` (Apple silicon and Intel) and one `.exe`. Upload the `.dmg` and `.exe` somewhere public (GitHub Releases
works), then set `DOWNLOAD_MAC_URL` and `DOWNLOAD_WINDOWS_URL` on the server so `/welcome` links
to them.

## Mac: Developer ID + notarization

| Variable | Where it comes from |
|---|---|
| `CSC_LINK` | A **Developer ID Application** certificate exported from Keychain Access as `.p12` (file path or base64). Needs a paid Apple Developer account. |
| `CSC_KEY_PASSWORD` | The password you set when exporting the `.p12`. |
| `CSC_NAME` | Instead of the two above: the certificate's name, if it's already in this Mac's keychain. |
| `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | App Store Connect → Users and Access → Integrations → App Store Connect API. Download the `.p8` key (path goes in `APPLE_API_KEY`). Recommended. |
| `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` | Alternative to the API key: your Apple ID, an app-specific password from appleid.apple.com, and the team ID from the developer portal. |

The app is signed with the hardened runtime (`build/entitlements.mac.plist`: JIT and outgoing
network only) and notarized during the build. Notarization usually takes a few minutes.

## Windows

Pick one.

| Option | Variables |
|---|---|
| Certificate file | `WIN_CSC_LINK` (`.pfx`, path or base64) and `WIN_CSC_KEY_PASSWORD`. Most certificate authorities now issue code-signing certificates only on hardware tokens or cloud key stores, so a `.pfx` may not be available. |
| Azure Trusted Signing | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_SIGN_ENDPOINT` (e.g. `https://eus.codesigning.azure.net`), `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE`, `WIN_PUBLISHER_NAME` (must match the certificate's subject). Runs on Windows. |

New certificates build SmartScreen reputation over the first few hundred installs, so early
installs may still show "Windows protected your PC" with a **Run anyway** option.

## Not verified yet

The build was checked unsigned (`UNSIGNED=1`, packaging succeeds). Signing and notarizing need the
real certificates above, so run the first signed build yourself and confirm with
`spctl -a -vv /Applications/Reviewloop.app` (Mac) and the file's Digital Signatures tab (Windows).
