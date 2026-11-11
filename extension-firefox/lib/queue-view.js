/* Shared queue view for extension pages and YouTube (GPL-3.0). */
(() => {
  "use strict";

  const api = globalThis.browser || chrome;

  async function request(type, details) {
    const response = await api.runtime.sendMessage({ type, ...details });
    if (!response?.ok) throw new Error(response?.error || "Queue unavailable");
    return response.value;
  }

  function button(label, action) {
    const el = document.createElement("button");
    el.type = "button";
    el.textContent = label;
    el.addEventListener("click", (event) => {
      if (event.isTrusted) action(event);
    });
    return el;
  }

  function mount(container, { onView } = {}) {
    const status = document.createElement("p");
    status.setAttribute("role", "status");
    const label = document.createElement("label");
    const autoplay = document.createElement("input");
    autoplay.type = "checkbox";
    label.append(autoplay, " Autoplay next");
    const list = document.createElement("ol");
    const setup = button("Queue settings", () => request("QUEUE_SETTINGS").catch(showError));
    container.append(label, status, list);
    if (!onView) container.append(setup);
    container.classList.add("yt-tldw-queue");
    let signature;
    let loading = false;

    function showError(error) {
      status.textContent = error.message;
    }

    function render(view) {
      onView?.(view);
      if (!view.origin) status.textContent = "Queue is stored on this device.";
      else if (view.error) status.textContent = `${view.error} · ${view.pending} pending`;
      else if (view.pending) status.textContent = `${view.pending} change(s) waiting to sync.`;
      else status.textContent = "Queue synced.";
      const key = JSON.stringify(view.entries);
      if (key === signature) return;
      signature = key;
      const previousFocus = document.activeElement?.dataset.queueAction;
      list.replaceChildren();
      function control(li, entry, label, handler, disabled = false) {
        const element = button(label, handler);
        element.dataset.queueAction = `${entry.videoId}:${label}`;
        element.disabled = disabled;
        li.append(element);
      }
      const edit = (operation) => request("QUEUE_EDIT", { operation }).then(render, showError);
      view.entries.forEach((entry, index) => {
        const li = document.createElement("li");
        const title = document.createElement("span");
        title.textContent = entry.title;
        li.append(title);
        control(li, entry, "Play", () => request("QUEUE_OPEN", { videoId: entry.videoId }).catch(showError));
        const move = (beforeId) => edit({ type: "move", videoId: entry.videoId, beforeId });
        control(li, entry, "Up", () => move(view.entries[index - 1].videoId), index === 0);
        control(li, entry, "Down", () => move(view.entries[index + 2]?.videoId ?? null), index === view.entries.length - 1);
        control(li, entry, "Remove", () => edit({ type: "remove", videoId: entry.videoId }));
        list.append(li);
      });
      if (!view.entries.length) {
        const item = document.createElement("li");
        item.textContent = "Your queue is empty.";
        list.append(item);
      }
      if (previousFocus) {
        [...list.querySelectorAll("button")].find((el) => el.dataset.queueAction === previousFocus)?.focus();
      }
    }

    async function refresh(sync = false) {
      if (!container.isConnected || container.hidden || document.hidden) return;
      if (sync && loading) return;
      if (sync) loading = true;
      try {
        // Read current local state after the sync completes so late replies cannot roll back the UI.
        if (sync) await request("QUEUE_SYNC");
        render(await request("QUEUE_VIEW"));
      } catch (error) {
        showError(error);
      } finally {
        if (sync) loading = false;
      }
    }

    autoplay.addEventListener("change", (event) => {
      if (!event.isTrusted) return;
      api.storage.local.set({ queueAutoplay: autoplay.checked }).catch(showError);
    });
    api.storage.local.get({ queueAutoplay: false }).then((data) => {
      autoplay.checked = data.queueAutoplay;
    }).catch(showError);
    api.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.queueAutoplay) autoplay.checked = changes.queueAutoplay.newValue;
      if (changes.queueChanged) refresh();
    });
    document.addEventListener("visibilitychange", () => refresh(true));
    window.addEventListener("online", () => refresh(true));
    setInterval(() => refresh(true), 30000);
    refresh();
    refresh(true);
    return { refresh };
  }

  globalThis.YtTldwQueueView = { mount, request, button };
})();
