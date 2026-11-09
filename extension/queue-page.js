/* YT-TLDW private pairing page (GPL-3.0). */
(() => {
  const api = globalThis.browser || chrome;
  const { mount, request } = globalThis.YtTldwQueueView;
  const form = document.getElementById("pair");
  const originField = document.getElementById("origin");
  const keyField = document.getElementById("key");
  const status = document.getElementById("pair-status");
  const allow = document.getElementById("allow-sync");
  const firefox = navigator.userAgent.includes("Firefox/");
  const dataPermission = { data_collection: ["websiteContent", "authenticationInfo"] };
  if (location.hash === "#settings") document.getElementById("settings").open = true;

  const queue = mount(document.getElementById("queue"), {
    onView(view) {
      if (view.origin && !originField.value) originField.value = view.origin;
    },
  });

  if (firefox) {
    const updateConsent = () => api.permissions.contains(dataPermission).then((allowed) => { allow.hidden = allowed; });
    updateConsent().catch(() => { allow.hidden = false; });
    allow.addEventListener("click", () => {
      api.permissions.request(dataPermission).then(updateConsent).catch(() => {
        status.textContent = "Firefox could not request queue sync consent.";
      });
    });
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const origin = globalThis.YtTldwQueueSync.syncOrigin(originField.value.trim());
    if (!origin || !/^[A-Za-z0-9_-]{43}$/.test(keyField.value.trim())) {
      status.textContent = "Enter a Tailscale HTTPS address and a valid access key.";
      return;
    }
    const submit = form.querySelector("button");
    submit.disabled = true;
    status.textContent = "Connecting…";
    try {
      if (!await api.permissions.request({ origins: [`${origin}/*`] })) throw new Error("Allow server access to connect");
      await request("QUEUE_CONNECT", { origin, key: keyField.value.trim() });
      keyField.value = "";
      status.textContent = "Connected.";
      await queue.refresh(true);
    } catch (error) {
      status.textContent = error.message;
    } finally {
      submit.disabled = false;
    }
  });
  document.getElementById("sync-now").addEventListener("click", () => queue.refresh(true));
})();
