const DEFAULTS = { enabled: false, method: "auto", debug: true };

async function load() {
  const data = await chrome.storage.local.get(DEFAULTS);
  document.getElementById("method").value = data.method || "auto";
  document.getElementById("debug").checked = data.debug !== false;
  document.getElementById("enabled").checked = !!data.enabled;
}

async function save({ quiet } = {}) {
  const method = document.getElementById("method").value;
  const debug = document.getElementById("debug").checked;
  const enabled = document.getElementById("enabled").checked;
  await chrome.storage.local.set({ method, debug, enabled });
  try {
    await chrome.runtime.sendMessage({ type: "YT_TLDW_SET_ENABLED", enabled });
  } catch (_) {}
  const status = document.getElementById("status");
  if (!quiet && status) {
    status.hidden = false;
    status.textContent = `Saved (method=${method})`;
    setTimeout(() => (status.hidden = true), 1500);
  }
}

document.getElementById("save").addEventListener("click", () => save());
document.getElementById("method").addEventListener("change", () => save({ quiet: false }));
document.getElementById("debug").addEventListener("change", () => save({ quiet: true }));
document.getElementById("enabled").addEventListener("change", () => save({ quiet: true }));
load();
