/* YT-TLDW theme for extension pages (popup, options, queue) — GPL-3.0.
 * Setting: storage.local `theme` = "dark" (default) | "light" | "oled". Applied as <html data-theme>.
 * The last value is mirrored in localStorage so pages paint in the right theme without a flash. */
(function () {
  const api = globalThis.browser || chrome;
  const KEY = "theme";
  const CACHE = "ytTldwTheme";
  const norm = (v) => (v === "light" || v === "oled" ? v : "dark");

  function apply(theme) {
    document.documentElement.dataset.theme = norm(theme);
  }
  function paintControls(theme) {
    for (const el of document.querySelectorAll('input[name="theme"]')) el.checked = el.value === norm(theme);
  }
  function remember(theme) {
    try {
      localStorage.setItem(CACHE, norm(theme));
    } catch (_) {}
  }

  let cached = null;
  try {
    cached = localStorage.getItem(CACHE);
  } catch (_) {}
  apply(cached);

  let current = norm(cached);
  function sync(theme) {
    current = norm(theme);
    remember(current);
    apply(current);
    paintControls(current);
  }

  api.storage.local.get({ [KEY]: "dark" }).then((data) => sync(data[KEY])).catch(() => {});
  api.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[KEY]) sync(changes[KEY].newValue);
  });

  document.addEventListener("DOMContentLoaded", () => {
    paintControls(current);
    for (const el of document.querySelectorAll('input[name="theme"]')) {
      el.addEventListener("change", () => {
        if (!el.checked) return;
        sync(el.value);
        api.storage.local.set({ [KEY]: norm(el.value) }).catch(() => {});
      });
    }
  });
})();
