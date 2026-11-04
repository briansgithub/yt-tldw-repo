const S = self.YtTldwSettings;
const DEFAULTS = S.DEFAULTS;

async function load() {
  const data = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("method").value = S.normalizeMethod(data.method);
  document.getElementById("debug").checked = data.debug !== false;
  document.getElementById("enabled").checked = !!data.enabled;
  const g = S.normalizeGenre(data.genre);
  const i = S.normalizeIntensity(data.intensity);
  for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
  for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
}

async function save({ quiet } = {}) {
  const method = document.getElementById("method").value;
  const debug = document.getElementById("debug").checked;
  const enabled = document.getElementById("enabled").checked;
  const genre =
    document.querySelector('input[name="genre"]:checked')?.value || DEFAULTS.genre;
  const intensity =
    document.querySelector('input[name="intensity"]:checked')?.value || DEFAULTS.intensity;
  await chrome.runtime.sendMessage({
    type: "YT_TLDW_SET_SETTINGS",
    settings: { method, debug, enabled, genre, intensity },
  });
  const status = document.getElementById("status");
  if (!quiet && status) {
    status.hidden = false;
    status.textContent = `Saved (${genre}/${intensity}, method=${method})`;
    setTimeout(() => (status.hidden = true), 1600);
  }
}

document.getElementById("save").addEventListener("click", () => save());
document.getElementById("method").addEventListener("change", () => save({ quiet: false }));
document.getElementById("debug").addEventListener("change", () => save({ quiet: true }));
document.getElementById("enabled").addEventListener("change", () => save({ quiet: true }));
for (const el of document.querySelectorAll('input[name="genre"], input[name="intensity"]')) {
  el.addEventListener("change", () => save({ quiet: false }));
}
load();
