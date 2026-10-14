import { fetchStatus, getServer, paintBadge } from "./shared.js";

async function refresh() {
  const server = await getServer();
  if (!server) return;
  const status = await fetchStatus(server);
  await paintBadge(status);
  const { lastUnacked = 0 } = await chrome.storage.session.get("lastUnacked");
  if (status.unacked > lastUnacked && status.latest) {
    chrome.notifications.create("rl-issue", {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title: status.latestUrgent ? "Urgent guest issue" : "New guest issue",
      message: status.latest,
      priority: status.latestUrgent ? 2 : 1,
    });
  }
  if (typeof status.unacked === "number") await chrome.storage.session.set({ lastUnacked: status.unacked });
}

chrome.runtime.onInstalled.addListener(() => chrome.alarms.create("refresh", { periodInMinutes: 1 }));
chrome.runtime.onStartup.addListener(() => chrome.alarms.create("refresh", { periodInMinutes: 1 }));
chrome.alarms.onAlarm.addListener((a) => a.name === "refresh" && refresh());
chrome.storage.onChanged.addListener((c) => c.server && refresh());
chrome.runtime.onMessage.addListener((msg) => msg === "refresh" && refresh());
chrome.notifications.onClicked.addListener(async () => {
  const server = await getServer();
  if (server) chrome.tabs.create({ url: `${server}/issues` });
});
