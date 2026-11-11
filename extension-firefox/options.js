const S = self.YtTldwSettings;
const extension = globalThis.browser || chrome;
const DEFAULTS = S.DEFAULTS;

/** Saved baseline from extension.storage. */
let saved = {
  enabled: false,
  debug: true,
  method: "auto",
  genre: "facts",
  intensity: "mild",
};

function selectedGenre() {
  return document.querySelector('input[name="genre"]:checked')?.value || saved.genre;
}
function selectedIntensity() {
  return document.querySelector('input[name="intensity"]:checked')?.value || saved.intensity;
}
function selectedMethod() {
  return document.getElementById("method").value || saved.method;
}

function isDirty() {
  return (
    S.normalizeGenre(selectedGenre()) !== S.normalizeGenre(saved.genre) ||
    S.normalizeIntensity(selectedIntensity()) !== S.normalizeIntensity(saved.intensity) ||
    S.normalizeMethod(selectedMethod()) !== S.normalizeMethod(saved.method)
  );
}

function updateApplyUi({ justApplied } = {}) {
  const btn = document.getElementById("apply");
  const status = document.getElementById("apply-status");
  const dirty = isDirty();
  // Always allow Apply so a re-click refreshes sections and jumps to the first.
  btn.disabled = false;
  btn.title = dirty ? "Apply settings and refresh" : "Refresh sections and jump to first";
  if (justApplied) {
    status.hidden = false;
    status.textContent = "Applied";
    clearTimeout(updateApplyUi._t);
    updateApplyUi._t = setTimeout(() => {
      status.hidden = true;
    }, 1600);
  } else if (dirty) {
    status.hidden = true;
  }
}

function paintFromSaved() {
  document.getElementById("enabled").checked = !!saved.enabled;
  document.getElementById("debug").checked = saved.debug !== false;
  document.getElementById("method").value = S.normalizeMethod(saved.method);
  const g = S.normalizeGenre(saved.genre);
  const i = S.normalizeIntensity(saved.intensity);
  for (const el of document.querySelectorAll('input[name="genre"]')) el.checked = el.value === g;
  for (const el of document.querySelectorAll('input[name="intensity"]')) el.checked = el.value === i;
  updateApplyUi();
}

async function load() {
  const data = await extension.storage.local.get(DEFAULTS);
  saved = {
    enabled: !!data.enabled,
    debug: data.debug !== false,
    method: S.normalizeMethod(data.method),
    genre: S.normalizeGenre(data.genre),
    intensity: S.normalizeIntensity(data.intensity),
  };
  paintFromSaved();
}

async function setSettings(partial) {
  return extension.runtime.sendMessage({ type: "YT_TLDW_SET_SETTINGS", settings: partial });
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
document.getElementById("method").addEventListener("change", () => updateApplyUi());

document.getElementById("apply").addEventListener("click", async () => {
  const genre = S.normalizeGenre(selectedGenre());
  const intensity = S.normalizeIntensity(selectedIntensity());
  const method = S.normalizeMethod(selectedMethod());
  const state = await setSettings({ genre, intensity, method, applyAt: Date.now() });
  saved.genre = S.normalizeGenre(state.genre);
  saved.intensity = S.normalizeIntensity(state.intensity);
  saved.method = S.normalizeMethod(state.method);
  paintFromSaved();
  updateApplyUi({ justApplied: true });
});

extension.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.enabled) {
    saved.enabled = !!changes.enabled.newValue;
    document.getElementById("enabled").checked = saved.enabled;
  }
  if (changes.debug) {
    saved.debug = changes.debug.newValue !== false;
    document.getElementById("debug").checked = saved.debug;
  }
  const dirty = isDirty();
  if (changes.genre) saved.genre = S.normalizeGenre(changes.genre.newValue);
  if (changes.intensity) saved.intensity = S.normalizeIntensity(changes.intensity.newValue);
  if (changes.method) saved.method = S.normalizeMethod(changes.method.newValue);
  if ((changes.genre || changes.intensity || changes.method) && !dirty) {
    paintFromSaved();
  } else {
    updateApplyUi();
  }
});

load();
