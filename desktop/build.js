// Builds the Mac and Windows installers. Signing comes from environment variables, so a signed,
// notarized build is one command:
//
//   REVIEWLOOP_URL=https://reviewloop.yourhotel.com npm run dist          # both, signed
//   npm run dist -- --mac                                                  # one platform
//   UNSIGNED=1 npm run dist                                                # local testing only
//
// It refuses to make an unsigned build unless UNSIGNED=1, so an unsigned installer never goes to
// a hotel by accident. Variables (see SIGNING.md for where each one comes from):
//
//   Mac signing:      CSC_LINK (Developer ID Application .p12, path or base64) + CSC_KEY_PASSWORD,
//                     or CSC_NAME for a certificate already in this Mac's keychain
//   Mac notarizing:   APPLE_API_KEY + APPLE_API_KEY_ID + APPLE_API_ISSUER   (recommended)
//                     or APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
//                     or APPLE_KEYCHAIN + APPLE_KEYCHAIN_PROFILE
//   Windows signing:  WIN_CSC_LINK (.pfx) + WIN_CSC_KEY_PASSWORD
//                     or Azure Trusted Signing: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET,
//                     AZURE_SIGN_ENDPOINT, AZURE_SIGN_ACCOUNT, AZURE_SIGN_PROFILE, WIN_PUBLISHER_NAME
const { execFileSync } = require("node:child_process");
const { join } = require("node:path");

const env = process.env;
const has = (...keys) => keys.every((k) => env[k] && env[k].trim());
const args = process.argv.slice(2);
const wantMac = args.includes("--mac") || !args.includes("--win");
const wantWin = args.includes("--win") || !args.includes("--mac");
const unsigned = env.UNSIGNED === "1";

/** What's set and what's missing, per platform. Exported for the preflight check. */
function plan() {
  const mac = {
    sign: has("CSC_LINK") || has("CSC_NAME"),
    notarize: has("APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER") || has("APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID") || has("APPLE_KEYCHAIN", "APPLE_KEYCHAIN_PROFILE"),
  };
  const azure = has("AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET", "AZURE_SIGN_ENDPOINT", "AZURE_SIGN_ACCOUNT", "AZURE_SIGN_PROFILE", "WIN_PUBLISHER_NAME");
  const win = { pfx: has("WIN_CSC_LINK"), azure };
  const problems = [];
  if (wantMac && !mac.sign) problems.push("Mac: set CSC_LINK and CSC_KEY_PASSWORD (Developer ID Application certificate), or CSC_NAME.");
  if (wantMac && !mac.notarize) problems.push("Mac: set APPLE_API_KEY, APPLE_API_KEY_ID and APPLE_API_ISSUER (or APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID) to notarize.");
  if (wantWin && !win.pfx && !win.azure) problems.push("Windows: set WIN_CSC_LINK and WIN_CSC_KEY_PASSWORD, or the AZURE_* Trusted Signing variables.");
  if (wantMac && process.platform !== "darwin") problems.push("Mac installers must be built and notarized on a Mac.");
  if (wantWin && win.azure && process.platform !== "win32") problems.push("Azure Trusted Signing runs on Windows; build the Windows installer there (or in Windows CI).");
  return { mac, win, problems };
}

function main() {
  const { win, problems } = plan();
  const overrides = [];
  if (unsigned) {
    console.warn("UNSIGNED=1: building unsigned installers. Do not send these to hotels.");
    overrides.push("-c.mac.identity=null", "-c.mac.notarize=false", "-c.forceCodeSigning=false");
  } else {
    if (problems.length) {
      console.error("Can't make a signed build yet:\n  - " + problems.join("\n  - ") + "\nSee desktop/SIGNING.md. For a local test build, run UNSIGNED=1 npm run dist.");
      process.exit(1);
    }
    overrides.push("-c.forceCodeSigning=true");
    if (wantWin && !win.pfx && win.azure) {
      overrides.push(
        `-c.win.azureSignOptions.publisherName=${env.WIN_PUBLISHER_NAME}`,
        `-c.win.azureSignOptions.endpoint=${env.AZURE_SIGN_ENDPOINT}`,
        `-c.win.azureSignOptions.codeSigningAccountName=${env.AZURE_SIGN_ACCOUNT}`,
        `-c.win.azureSignOptions.certificateProfileName=${env.AZURE_SIGN_PROFILE}`,
      );
    }
  }
  execFileSync(process.execPath, [join(__dirname, "configure.js")], { stdio: "inherit" });
  const platforms = [...(wantMac ? ["--mac"] : []), ...(wantWin ? ["--win"] : [])];
  const cli = join(__dirname, "node_modules", "electron-builder", "cli.js");
  execFileSync(process.execPath, [cli, ...platforms, ...overrides, ...args.filter((a) => a !== "--mac" && a !== "--win")], { stdio: "inherit", cwd: __dirname });
}

if (require.main === module) main();
module.exports = { plan };
