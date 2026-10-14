import { fetchStatus, getServer, paintBadge, setServer } from "./shared.js";

const $ = (id) => document.getElementById(id);
let server = await getServer();

const open = (path) => chrome.tabs.create({ url: server + path });
document.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => open(el.dataset.go)));

$("change").onclick = () => showSetup();

$("setup-form").onsubmit = async (e) => {
  e.preventDefault();
  $("err").textContent = "";
  let origin;
  try {
    const raw = $("url").value.trim();
    origin = new URL(/^https?:\/\//.test(raw) ? raw : `https://${raw}`).origin;
  } catch {
    $("err").textContent = "That doesn't look like a web address.";
    return;
  }
  // Chrome asks the person to allow access to just this one site.
  const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
  if (!granted) {
    $("err").textContent = "Reviewloop needs permission to read your console's counts.";
    return;
  }
  await setServer(origin);
  server = origin;
  showStatus();
};

function showSetup() {
  $("setup").hidden = false;
  $("status").hidden = true;
  $("foot").hidden = true;
  $("url").value = server ? new URL(server).host : "";
  $("url").focus();
}

async function showStatus() {
  $("setup").hidden = true;
  $("status").hidden = false;
  $("foot").hidden = false;
  $("host").textContent = new URL(server).host;
  const s = await fetchStatus(server);
  paintBadge(s);
  chrome.runtime.sendMessage("refresh").catch(() => {});
  if (s.signedOut || s.offline) {
    ["unacked", "urgent", "awaiting"].forEach((k) => ($(k).textContent = "–"));
    $("note").hidden = false;
    $("note").textContent = s.signedOut ? "Sign in to the console in this browser, then open this again." : "Can't reach the console right now.";
    $("primary").textContent = s.signedOut ? "Sign in" : "Open the console";
    $("primary").dataset.go = s.signedOut ? "/login" : "/issues";
    return;
  }
  $("unacked").textContent = s.unacked;
  $("urgent").textContent = s.urgent;
  $("awaiting").textContent = s.awaiting;
  $("urgent").parentElement.classList.toggle("hot", s.urgent > 0);
  $("unacked").parentElement.classList.toggle("hot", s.unacked > 0);
  if (s.latest) {
    $("latest").hidden = false;
    $("latest").textContent = s.latest;
  }
}

if (server) showStatus();
else showSetup();
