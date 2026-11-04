const S = self.YtTldwSettings;

async function load() {
  const state = await chrome.runtime.sendMessage({ type: "YT_TLDW_GET_STATE" });
  document.getElementById("enabled").checked = !!state.enabled;
  const g = S.normalizeGenre(state.genre);
  const i = S.normalizeIntensity(state.intensity);
  for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
  for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
}

async function setSettings(partial) {
  await chrome.runtime.sendMessage({ type: "YT_TLDW_SET_SETTINGS", settings: partial });
}

document.getElementById("enabled").addEventListener("change", (e) => {
  setSettings({ enabled: e.target.checked });
});

for (const el of document.querySelectorAll('input[name="genre"]')) {
  el.addEventListener("change", () => {
    if (el.checked) setSettings({ genre: el.value });
  });
}
for (const el of document.querySelectorAll('input[name="intensity"]')) {
  el.addEventListener("change", () => {
    if (el.checked) setSettings({ intensity: el.value });
  });
}

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) document.getElementById("enabled").checked = !!changes.enabled.newValue;
  if (changes.genre) {
    const g = S.normalizeGenre(changes.genre.newValue);
    for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
  }
  if (changes.intensity) {
    const i = S.normalizeIntensity(changes.intensity.newValue);
    for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
  }
});

load();
