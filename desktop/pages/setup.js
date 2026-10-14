const form = document.getElementById("f");
const err = document.getElementById("err");
const demo = new URLSearchParams(location.search).get("demo");

async function connect(value) {
  err.textContent = "";
  try {
    await window.reviewloopDesktop.setServer(value.trim());
  } catch {
    err.textContent = "That doesn't look like a web address. Try something like reviewloop.yourhotel.com";
  }
}
form.addEventListener("submit", (e) => {
  e.preventDefault();
  connect(form.url.value);
});
if (demo) {
  const btn = document.getElementById("demo");
  btn.hidden = false;
  btn.onclick = () => connect(demo);
}
