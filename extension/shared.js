// Shared by the popup and the background worker.
export const getServer = async () => (await chrome.storage.sync.get("server")).server || "";
export const setServer = (server) => chrome.storage.sync.set({ server });

/** Signed-in status from the console, or { signedOut } / { offline }. Uses the console's own session cookie. */
export async function fetchStatus(server) {
  try {
    const res = await fetch(`${server}/api/status`, { credentials: "include", headers: { accept: "application/json" } });
    if (res.status === 401) return { signedOut: true };
    if (!res.ok) return { offline: true };
    return await res.json();
  } catch {
    return { offline: true };
  }
}

export async function paintBadge(status) {
  const n = status.unacked || 0;
  await chrome.action.setBadgeText({ text: status.signedOut || status.offline ? "" : n ? String(n) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: status.urgent ? "#A8402B" : "#29251E" });
  await chrome.action.setBadgeTextColor?.({ color: "#FBFAF7" });
}
