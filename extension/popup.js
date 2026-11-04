const S = self.YtTldwSettings;

/** Saved settings currently in chrome.storage (source of truth). */
let saved = { enabled: false, debug: true, genre: "facts", intensity: "mild" };

function selectedGenre() {
  return document.querySelector('input[name="genre"]:checked')?.value || saved.genre;
}
function selectedIntensity() {
  return document.querySelector('input[name="intensity"]:checked')?.value || saved.intensity;
}

function isDirty() {
  return (
    S.normalizeGenre(selectedGenre()) !== S.normalizeGenre(saved.genre) ||
    S.normalizeIntensity(selectedIntensity()) !== S.normalizeIntensity(saved.intensity)
  );
}

function updateApplyUi({ justApplied } = {}) {
  const btn = document.getElementById("apply");
  const status = document.getElementById("apply-status");
  const dirty = isDirty();
  btn.disabled = !dirty;
  if (justApplied) {
    status.hidden = false;
    status.textContent = "Applied";
    clearTimeout(updateApplyUi._t);
    updateApplyUi._t = setTimeout(() => {
      status.hidden = true;
    }, 1400);
  } else if (dirty) {
    status.hidden = true;
  }
}

function paintFromSaved() {
  document.getElementById("enabled").checked = !!saved.enabled;
  document.getElementById("debug").checked = saved.debug !== false;
  const g = S.normalizeGenre(saved.genre);
  const i = S.normalizeIntensity(saved.intensity);
  for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
  for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
  updateApplyUi();
}

async function load() {
  const state = await chrome.runtime.sendMessage({ type: "YT_TLDW_GET_STATE" });
  saved = {
    enabled: !!state.enabled,
    debug: state.debug !== false,
    genre: S.normalizeGenre(state.genre),
    intensity: S.normalizeIntensity(state.intensity),
  };
  paintFromSaved();
}

async function setSettings(partial) {
  return chrome.runtime.sendMessage({ type: "YT_TLDW_SET_SETTINGS", settings: partial });
}

document.getElementById("enabled").addEventListener("change", async (e) => {
  const state = await setSettings({ enabled: e.target.checked });
  saved.enabled = !!state.enabled;
});

document.getElementById("debug").addEventListener("change", async (e) => {
  const state = await setSettings({ debug: e.target.checked });
  saved.debug = state.debug !== false;
});

for (const el of document.querySelectorAll('input[name="genre"], input[name="intensity"]')) {
  el.addEventListener("change", () => updateApplyUi());
}

document.getElementById("apply").addEventListener("click", async () => {
  if (!isDirty()) return;
  const genre = S.normalizeGenre(selectedGenre());
  const intensity = S.normalizeIntensity(selectedIntensity());
  const state = await setSettings({ genre, intensity });
  saved.genre = S.normalizeGenre(state.genre);
  saved.intensity = S.normalizeIntensity(state.intensity);
  paintFromSaved();
  updateApplyUi({ justApplied: true });
});

document.getElementById("open-options").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  // Instant toggles always mirror storage
  if (changes.enabled) {
    saved.enabled = !!changes.enabled.newValue;
    document.getElementById("enabled").checked = saved.enabled;
  }
  if (changes.debug) {
    saved.debug = changes.debug.newValue !== false;
    document.getElementById("debug").checked = saved.debug;
  }
  // Genre/intensity: update saved baseline; only repaint radios when not dirty
  // so in-progress staging is not clobbered by our own Apply write.
  const dirty = isDirty();
  if (changes.genre) saved.genre = S.normalizeGenre(changes.genre.newValue);
  if (changes.intensity) saved.intensity = S.normalizeIntensity(changes.intensity.newValue);
  if ((changes.genre || changes.intensity) && !dirty) {
    const g = S.normalizeGenre(saved.genre);
    const i = S.normalizeIntensity(saved.intensity);
    for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
    for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
  }
  updateApplyUi();
});

load();
