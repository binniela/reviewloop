const url = new URLSearchParams(location.search).get("url");
if (url) document.getElementById("where").textContent = new URL(url).host;
document.getElementById("retry").onclick = () => window.reviewloopDesktop.retry();
// Try again on its own every 15 seconds, and as soon as the network comes back.
setInterval(() => window.reviewloopDesktop.retry(), 15000);
window.addEventListener("online", () => window.reviewloopDesktop.retry());
